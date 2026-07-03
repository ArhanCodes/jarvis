/**
 * JARVIS Watch WebSocket Server
 *
 * Advertises via Bonjour (_jarvis._tcp) so the Apple Watch app auto-discovers it.
 * Receives voice commands from the watch, processes them through the conversation engine,
 * streams tokens back, and sends TTS audio as base64-encoded MP3 chunks.
 *
 * Protocol (JSON over WebSocket):
 *   Watch → Server:
 *     { type: "command", text: "...", requestId: "..." }
 *     { type: "ping" }
 *
 *   Server → Watch:
 *     { type: "status", state: "idle"|"processing"|"speaking", lastCommand: "..." }
 *     { type: "token", text: "..." }
 *     { type: "audio", data: "<base64 mp3>" }
 *     { type: "audioEnd" }
 *     { type: "error", message: "..." }
 *     { type: "pong" }
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, Server } from 'http';
import { conversationEngine } from '../core/conversation-engine.js';
import { parse } from '../core/parser.js';
import { execute } from '../core/executor.js';
import { llmVision } from '../utils/llm.js';
import { runBuild } from '../modules/builder.js';
import { readFileSync, existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { configPath } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const execAsync = promisify(exec);
const log = createLogger('ws-server');

// ── Config ──

interface WatchServerConfig {
  port: number;
  ttsProvider: 'elevenlabs' | 'edge-tts' | 'macos';
}

function loadConfig(): WatchServerConfig {
  // Re-use voice.json for TTS provider info
  let ttsProvider: 'elevenlabs' | 'edge-tts' | 'macos' = 'edge-tts';
  const voicePath = configPath('voice.json');
  try {
    if (existsSync(voicePath)) {
      const vc = JSON.parse(readFileSync(voicePath, 'utf-8'));
      ttsProvider = vc.provider || 'edge-tts';
    }
  } catch (err) { log.debug('Failed to load voice config', err); }

  return { port: 5225, ttsProvider };
}

// ── TTS: generate MP3 file from text ──

interface VoiceJson {
  provider: string;
  elevenlabs?: { apiKey: string; voiceId: string; model?: string };
  edgeTts?: { voice: string; rate?: string; pitch?: string };
}

function loadVoiceJson(): VoiceJson {
  const voicePath = configPath('voice.json');
  try {
    if (existsSync(voicePath)) return JSON.parse(readFileSync(voicePath, 'utf-8'));
  } catch (err) { log.debug('Failed to load voice config', err); }
  return { provider: 'edge-tts' };
}

async function generateTTSAudio(text: string): Promise<Buffer | null> {
  const vc = loadVoiceJson();
  const tmpFile = join(tmpdir(), `jarvis-watch-tts-${Date.now()}.mp3`);

  try {
    // Try ElevenLabs first
    if (vc.provider === 'elevenlabs' && vc.elevenlabs?.apiKey && vc.elevenlabs?.voiceId) {
      const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vc.elevenlabs.voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': vc.elevenlabs.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: vc.elevenlabs.model || 'eleven_multilingual_v2',
          voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.15 },
        }),
      });

      if (resp.ok) {
        const arrayBuf = await resp.arrayBuffer();
        return Buffer.from(arrayBuf);
      }
      // Quota exceeded — fall through to Edge TTS
    }

    // Edge TTS
    const voice = vc.edgeTts?.voice || 'en-GB-RyanNeural';
    const rate = vc.edgeTts?.rate || '+0%';
    const pitch = vc.edgeTts?.pitch || '+0Hz';
    const escaped = text.replace(/'/g, "'\\''");

    await execAsync(
      `edge-tts --voice "${voice}" --rate="${rate}" --pitch="${pitch}" --text '${escaped}' --write-media "${tmpFile}"`,
      { timeout: 15000 },
    );

    if (existsSync(tmpFile)) {
      const buf = readFileSync(tmpFile);
      try { unlinkSync(tmpFile); } catch (err) { log.debug('Failed to clean up temp file', err); }
      return buf;
    }
  } catch (err) {
    log.debug('Edge TTS failed, trying macOS say', err);
    try {
      const aiffFile = tmpFile.replace('.mp3', '.aiff');
      const escaped = text.replace(/'/g, "'\\''");
      await execAsync(`say -v Daniel -o "${aiffFile}" '${escaped}'`, { timeout: 10000 });

      // Convert to mp3 for the watch
      await execAsync(`afconvert -f mp4f -d aac "${aiffFile}" "${tmpFile}"`, { timeout: 10000 });
      try { unlinkSync(aiffFile); } catch (err) { log.debug('Failed to clean up aiff file', err); }

      if (existsSync(tmpFile)) {
        const buf = readFileSync(tmpFile);
        try { unlinkSync(tmpFile); } catch (err) { log.debug('Failed to clean up temp file', err); }
        return buf;
      }
    } catch (err) { log.debug('All TTS methods failed', err); }
  }

  try { unlinkSync(tmpFile); } catch { /* ok */ }
  return null;
}

// ── Bonjour (dns-sd) ──

let bonjourProcess: ReturnType<typeof exec> | null = null;

function advertiseBonjourService(port: number): void {
  // Use macOS dns-sd to register the service
  bonjourProcess = exec(`dns-sd -R "JARVIS" _jarvis._tcp local ${port}`, () => {});
  bonjourProcess.unref();
}

function stopBonjour(): void {
  if (bonjourProcess) {
    bonjourProcess.kill();
    bonjourProcess = null;
  }
}

// ── WebSocket Server ──

let wss: WebSocketServer | null = null;
let httpServer: Server | null = null;
let activeClients = new Set<WebSocket>();

function sendJSON(ws: WebSocket, obj: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

async function playAudioOnMac(text: string): Promise<void> {
  const vc = loadVoiceJson();
  try {
    if (vc.provider === 'elevenlabs' && vc.elevenlabs?.apiKey && vc.elevenlabs?.voiceId) {
      // Generate with ElevenLabs, save to temp file, play with afplay
      const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vc.elevenlabs.voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': vc.elevenlabs.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: vc.elevenlabs.model || 'eleven_multilingual_v2',
          voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.15 },
        }),
      });

      if (resp.ok) {
        const tmpFile = join(tmpdir(), `jarvis-mac-tts-${Date.now()}.mp3`);
        const arrayBuf = await resp.arrayBuffer();
        writeFileSync(tmpFile, Buffer.from(arrayBuf));
        await execAsync(`afplay "${tmpFile}"`).catch(() => {});
        try { unlinkSync(tmpFile); } catch (err) { log.debug('Failed to clean up temp file', err); }
        return;
      }
    }

    // Edge TTS — generate and play locally
    const voice = vc.edgeTts?.voice || 'en-GB-RyanNeural';
    const rate = vc.edgeTts?.rate || '+0%';
    const pitch = vc.edgeTts?.pitch || '+0Hz';
    const escaped = text.replace(/'/g, "'\\''");
    const tmpFile = join(tmpdir(), `jarvis-mac-tts-${Date.now()}.mp3`);

    await execAsync(
      `edge-tts --voice "${voice}" --rate="${rate}" --pitch="${pitch}" --text '${escaped}' --write-media "${tmpFile}"`,
      { timeout: 15000 },
    );

    if (existsSync(tmpFile)) {
      await execAsync(`afplay "${tmpFile}"`).catch(() => {});
      try { unlinkSync(tmpFile); } catch (err) { log.debug('Failed to clean up temp file', err); }
      return;
    }
  } catch (err) { log.debug('TTS playback failed, falling back to macOS say', err); }

  // Fallback: macOS say
  const escaped = text.replace(/'/g, "'\\''");
  await execAsync(`say -v Daniel '${escaped}'`).catch(() => {});
}

// Analyze a pasted image with Claude vision and return the answer.
async function handleVision(ws: WebSocket, prompt: string, image: string, mediaType: string): Promise<void> {
  for (const client of activeClients) {
    sendJSON(client, { type: 'status', state: 'processing', lastCommand: prompt || 'image' });
  }
  try {
    const question = prompt.trim() || 'Describe this image. Be concise and specific.';
    const answer = await llmVision([{ data: image, mediaType }], question);
    if (ws.readyState === WebSocket.OPEN) sendJSON(ws, { type: 'token', text: answer.trim() });
  } finally {
    for (const client of activeClients) sendJSON(client, { type: 'status', state: 'idle' });
  }
}

// Claude Code-style autonomous build. Streams the agent's narration + tool
// activity to the pill token-by-token; no TTS (builds run for minutes).
async function handleBuild(ws: WebSocket, description: string): Promise<void> {
  // handleCommand already broadcast a 'processing' status before routing here.
  try {
    const res = await runBuild(description, {
      onText: (t) => { if (ws.readyState === WebSocket.OPEN) sendJSON(ws, { type: 'token', text: t }); },
      onEvent: (e) => { if (ws.readyState === WebSocket.OPEN) sendJSON(ws, { type: 'token', text: `\n· ${e.text}\n` }); },
    });
    const tail = res.ok
      ? `\n\n✅ Built in ${res.projectDir}\n   ${res.steps} steps · ${res.usedModel.replace('claude-', '')}`
      : `\n\n⚠️ ${res.summary}`;
    if (ws.readyState === WebSocket.OPEN) sendJSON(ws, { type: 'token', text: tail });
  } catch (err) {
    if (ws.readyState === WebSocket.OPEN) sendJSON(ws, { type: 'token', text: `\n\n⚠️ Build failed: ${(err as Error).message}` });
  } finally {
    for (const client of activeClients) sendJSON(client, { type: 'status', state: 'idle' });
  }
}

async function handleCommand(ws: WebSocket, text: string, requestId: string, noAudio: boolean = false, playOnMac: boolean = false): Promise<void> {
  console.log(`  [watch] Command: "${text}" (noAudio=${noAudio}, playOnMac=${playOnMac})`);

  // Broadcast status to ALL clients so Mac menubar sees it too
  for (const client of activeClients) {
    sendJSON(client, { type: 'status', state: 'processing', lastCommand: text });
  }

  // ── Fast path: deterministic module commands (WHOOP recovery, battery,
  // timers, conversions, weather…) route straight through parse()+execute()
  // — no LLM round-trip. ai-chat / unmatched fall through to the conversation
  // engine below (which streams general answers token-by-token to the client).
  try {
    const parsed = await parse(text);
    // Autonomous build ("build a snake game …") — its own streaming handler.
    if (parsed?.module === 'builder' && parsed.action === 'build') {
      await handleBuild(ws, parsed.args.description || text.replace(/^build\s+/i, '').trim());
      return;
    }
    // ai-chat's streaming actions go to the conversation engine; its
    // deterministic ones (set-model, ai-status, clear-chat) use the fast path.
    const aiChatStreaming = parsed?.module === 'ai-chat' && ['ask', 'summarize', 'explain'].includes(parsed.action);
    if (parsed && !aiChatStreaming) {
      const result = await execute(parsed);
      const reply = String(result.voiceMessage || result.message || (result.success ? 'Done, sir.' : 'That didn’t work, sir.')).trim();
      if (ws.readyState === WebSocket.OPEN) sendJSON(ws, { type: 'token', text: reply });

      if (!noAudio || playOnMac) {
        for (const client of activeClients) sendJSON(client, { type: 'status', state: 'speaking' });
        for (const sentence of reply.split(/(?<=[.!?])\s+/)) {
          const clean = sentence.replace(/\[.*?\]/g, '').replace(/\bjarvis\b[,.]?\s*/gi, '').trim();
          if (!clean) continue;
          if (playOnMac) await playAudioOnMac(clean);
          else {
            const audioBuf = await generateTTSAudio(clean);
            if (audioBuf && ws.readyState === WebSocket.OPEN) sendJSON(ws, { type: 'audio', data: audioBuf.toString('base64') });
          }
        }
        if (!playOnMac) sendJSON(ws, { type: 'audioEnd' });
      }
      for (const client of activeClients) sendJSON(client, { type: 'status', state: 'idle' });
      return;
    }
  } catch (err) {
    log.debug('Fast-path parse/execute failed; falling back to conversation engine', err);
  }

  const sentenceQueue: string[] = [];
  let buffer = '';
  let streamDone = false;

  // Stream response from conversation engine
  const streamPromise = conversationEngine.processUnmatched(text, {
    voiceMode: true,
    onToken: (token: string) => {
      // Send token to requesting client for live text display
      sendJSON(ws, { type: 'token', text: token });

      buffer += token;
      const trimmed = buffer.trim();
      const wordCount = trimmed.split(/\s+/).length;

      // Same sentence boundaries as voice-assistant
      if (/[.!?]["'）)]*\s*$/.test(trimmed) && wordCount >= 3) {
        sentenceQueue.push(trimmed);
        buffer = '';
      } else if (/\n\s*\n\s*$/.test(buffer) && wordCount >= 3) {
        sentenceQueue.push(trimmed);
        buffer = '';
      } else if (/[,;:]\s*$/.test(trimmed) && wordCount >= 7) {
        sentenceQueue.push(trimmed);
        buffer = '';
      } else if (wordCount >= 25) {
        sentenceQueue.push(trimmed);
        buffer = '';
      }
    },
  }).then(() => {
    if (buffer.trim()) sentenceQueue.push(buffer.trim());
    streamDone = true;
  }).catch(() => {
    streamDone = true;
  });

  if (noAudio && !playOnMac) {
    // Skip all audio — just wait for stream to finish
    await streamPromise.catch(() => {});
    for (const client of activeClients) {
      sendJSON(client, { type: 'status', state: 'idle' });
    }
    return;
  }

  for (const client of activeClients) {
    sendJSON(client, { type: 'status', state: 'speaking' });
  }

  // Generate and play/send audio for each sentence as it completes
  while (!streamDone || sentenceQueue.length > 0) {
    if (sentenceQueue.length > 0) {
      const sentence = sentenceQueue.shift()!
        .replace(/\[.*?\]/g, '')          // Strip bracket tags
        .replace(/\bjarvis\b[,.]?\s*/gi, '')
        .trim();

      if (sentence) {
        if (playOnMac) {
          // Play audio directly on the Mac speakers
          await playAudioOnMac(sentence);
        } else {
          // Send audio to the requesting client
          const audioBuf = await generateTTSAudio(sentence);
          if (audioBuf && ws.readyState === WebSocket.OPEN) {
            sendJSON(ws, { type: 'audio', data: audioBuf.toString('base64') });
          }
        }
      }
    } else {
      await new Promise(r => setTimeout(r, 30));
    }
  }

  if (!playOnMac) {
    sendJSON(ws, { type: 'audioEnd' });
  }

  for (const client of activeClients) {
    sendJSON(client, { type: 'status', state: 'idle' });
  }

  await streamPromise.catch(() => {});
}

// ── Public API ──

export function startWatchServer(): { port: number } | null {
  const config = loadConfig();

  try {
    httpServer = createServer();
    wss = new WebSocketServer({ server: httpServer });

    wss.on('connection', (ws) => {
      activeClients.add(ws);
      console.log(`  [watch] Apple Watch connected (${activeClients.size} client${activeClients.size > 1 ? 's' : ''})`);

      // Send initial state
      sendJSON(ws, { type: 'status', state: 'idle' });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'ping') {
            sendJSON(ws, { type: 'pong' });
            return;
          }

          if (msg.type === 'command' && msg.text) {
            handleCommand(ws, msg.text, msg.requestId || '', msg.noAudio === true, msg.playOnMac === true).catch((err) => {
              sendJSON(ws, { type: 'error', message: (err as Error).message });
              sendJSON(ws, { type: 'status', state: 'idle' });
            });
          }

          if (msg.type === 'vision' && msg.image) {
            handleVision(ws, msg.text || '', msg.image, msg.mediaType || 'image/png').catch((err) => {
              sendJSON(ws, { type: 'error', message: (err as Error).message });
              sendJSON(ws, { type: 'status', state: 'idle' });
            });
          }
        } catch (err) { log.debug('Failed to parse WebSocket message', err); }
      });

      ws.on('close', () => {
        activeClients.delete(ws);
        console.log(`  [watch] Apple Watch disconnected (${activeClients.size} client${activeClients.size > 1 ? 's' : ''})`);
      });

      ws.on('error', () => {
        activeClients.delete(ws);
      });
    });

    // listen() errors (e.g. EADDRINUSE when another JARVIS is already running)
    // arrive as an async 'error' event — without this they'd crash the whole
    // process. Warn and continue headless instead.
    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`  [watch] Port ${config.port} already in use — another JARVIS is likely running. Skipping watch server.`);
      } else {
        console.log(`  [watch] Server error: ${err.message}`);
      }
      try { httpServer?.close(); } catch { /* ignore */ }
      httpServer = null;
      wss = null;
    });

    httpServer.listen(config.port, '0.0.0.0', () => {
      console.log(`  [watch] WebSocket server on port ${config.port}`);
      advertiseBonjourService(config.port);
      console.log(`  [watch] Bonjour: advertising _jarvis._tcp`);
    });

    return { port: config.port };
  } catch (err) {
    console.log(`  [watch] Failed to start: ${(err as Error).message}`);
    return null;
  }
}

export function stopWatchServer(): void {
  for (const ws of activeClients) {
    ws.close();
  }
  activeClients.clear();

  if (wss) { wss.close(); wss = null; }
  if (httpServer) { httpServer.close(); httpServer = null; }
  stopBonjour();
}

export function getWatchClientCount(): number {
  return activeClients.size;
}
