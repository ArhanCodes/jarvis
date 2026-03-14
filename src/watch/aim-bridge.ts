/**
 * AIM Bridge for JARVIS
 *
 * Connects JARVIS to the AIM relay server.
 *
 * On Mac (local dev): registers as 'mac' device, connects to remote AIM.
 * On Linux VPS: registers as 'server' device, connects to localhost AIM.
 *   - Handles commands from all devices (phone, watch, Mac)
 *   - Forwards macOS commands to connected Mac client via mac-proxy
 *   - Generates TTS audio and streams to requesting devices
 */

import WebSocket from 'ws';
import { conversationEngine } from '../core/conversation-engine.js';
import { readFileSync, existsSync, unlinkSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { IS_MAC } from '../utils/platform.js';
import { setMacProxySender, handleMacProxyResult } from '../utils/mac-proxy.js';
import { generateTTSAudio } from '../utils/voice-output.js';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──

interface AIMBridgeConfig {
  url: string;       // ws://vps-ip:5225 or wss://vps-ip:5225
  token?: string;    // Auth token
  deviceName?: string;
}

function loadAIMConfig(): AIMBridgeConfig | null {
  const paths = [
    join(__dirname, '..', '..', 'config', 'aim.json'),
    join(__dirname, '..', '..', '..', 'config', 'aim.json'),
  ];

  for (const p of paths) {
    try {
      if (existsSync(p)) {
        const config = JSON.parse(readFileSync(p, 'utf-8'));
        if (config.url) return config;
      }
    } catch { /* ignore */ }
  }

  // Also check environment variables
  if (process.env.AIM_URL) {
    return {
      url: process.env.AIM_URL,
      token: process.env.AIM_TOKEN,
      deviceName: process.env.AIM_DEVICE_NAME || (IS_MAC ? 'JARVIS-Mac' : 'JARVIS-Server'),
    };
  }

  // On Linux VPS, default to localhost AIM
  if (!IS_MAC) {
    return {
      url: 'ws://localhost:5225',
      deviceName: 'JARVIS-Server',
    };
  }

  return null;
}

// ── TTS for Mac local playback (only used when running on Mac) ──

interface VoiceJson {
  provider: string;
  elevenlabs?: { apiKey: string; voiceId: string; model?: string };
  edgeTts?: { voice: string; rate?: string; pitch?: string };
}

function loadVoiceJson(): VoiceJson {
  const paths = [
    join(__dirname, '..', '..', 'config', 'voice.json'),
    join(__dirname, '..', '..', '..', 'config', 'voice.json'),
  ];
  for (const p of paths) {
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8'));
    } catch { /* ignore */ }
  }
  return { provider: 'edge-tts' };
}

/**
 * Play audio directly on Mac speakers.
 * Only used when JARVIS runs on Mac and playOnMac is requested.
 */
async function playAudioOnMac(text: string): Promise<void> {
  if (!IS_MAC) {
    // On VPS, forward playOnMac request to connected Mac client via AIM
    const audioBuf = await generateTTSAudio(text);
    if (audioBuf) {
      sendToAIM({ type: 'play_audio', data: audioBuf.toString('base64'), to: 'mac' });
    }
    return;
  }

  const vc = loadVoiceJson();
  try {
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
        const tmpFile = join(tmpdir(), `jarvis-aim-mac-${Date.now()}.mp3`);
        writeFileSync(tmpFile, Buffer.from(await resp.arrayBuffer()));
        await execAsync(`afplay "${tmpFile}"`).catch(() => {});
        try { unlinkSync(tmpFile); } catch { /* ok */ }
        return;
      }
    }

    const voice = vc.edgeTts?.voice || 'en-GB-RyanNeural';
    const rate = vc.edgeTts?.rate || '+0%';
    const pitch = vc.edgeTts?.pitch || '+0Hz';
    const escaped = text.replace(/'/g, "'\\''");
    const tmpFile = join(tmpdir(), `jarvis-aim-mac-${Date.now()}.mp3`);

    await execAsync(
      `edge-tts --voice "${voice}" --rate="${rate}" --pitch="${pitch}" --text '${escaped}' --write-media "${tmpFile}"`,
      { timeout: 15000 },
    );
    if (existsSync(tmpFile)) {
      await execAsync(`afplay "${tmpFile}"`).catch(() => {});
      try { unlinkSync(tmpFile); } catch { /* ok */ }
      return;
    }
  } catch { /* fall through */ }

  const escaped = text.replace(/'/g, "'\\''");
  await execAsync(`say -v Daniel '${escaped}'`).catch(() => {});
}

// ── AIM Bridge ──

let aimWs: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let aimConnected = false;

function sendToAIM(msg: Record<string, unknown>): void {
  if (aimWs && aimWs.readyState === WebSocket.OPEN) {
    aimWs.send(JSON.stringify(msg));
  }
}

async function handleAIMCommand(msg: any): Promise<void> {
  const text = msg.text;
  const requestId = msg.requestId || '';
  const respondTo = msg.respondTo || msg.from;
  const noAudio = msg.noAudio === true;
  const playOnMac = msg.playOnMac === true;

  console.log(`  [aim] Remote command: "${text}" → respond to ${respondTo} (noAudio=${noAudio}, playOnMac=${playOnMac})`);

  // Broadcast processing status
  sendToAIM({ type: 'status', state: 'processing', lastCommand: text });

  const sentenceQueue: string[] = [];
  let buffer = '';
  let streamDone = false;

  const streamPromise = conversationEngine.processUnmatched(text, {
    voiceMode: true,
    onToken: (token: string) => {
      // Send token to the requesting device
      sendToAIM({ type: 'token', text: token, to: respondTo, requestId });

      buffer += token;
      const trimmed = buffer.trim();
      const wordCount = trimmed.split(/\s+/).length;

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
    await streamPromise.catch(() => {});
    sendToAIM({ type: 'status', state: 'idle' });
    return;
  }

  sendToAIM({ type: 'status', state: 'speaking' });

  while (!streamDone || sentenceQueue.length > 0) {
    if (sentenceQueue.length > 0) {
      const sentence = sentenceQueue.shift()!
        .replace(/\[.*?\]/g, '')
        .replace(/\bjarvis\b[,.]?\s*/gi, '')
        .trim();

      if (sentence) {
        if (playOnMac) {
          await playAudioOnMac(sentence);
        } else {
          const audioBuf = await generateTTSAudio(sentence);
          if (audioBuf) {
            sendToAIM({ type: 'audio', data: audioBuf.toString('base64'), to: respondTo, requestId });
          }
        }
      }
    } else {
      await new Promise(r => setTimeout(r, 30));
    }
  }

  if (!playOnMac) {
    sendToAIM({ type: 'audioEnd', to: respondTo, requestId });
  }

  sendToAIM({ type: 'status', state: 'idle' });
  await streamPromise.catch(() => {});
}

function connectToAIM(config: AIMBridgeConfig): void {
  if (aimWs && aimWs.readyState === WebSocket.OPEN) return;

  // On VPS: register as 'server'. On Mac: register as 'mac'.
  const deviceType = IS_MAC ? 'mac' : 'server';
  const deviceId = IS_MAC ? 'jarvis-mac' : 'jarvis-server';
  const deviceName = config.deviceName || (IS_MAC ? 'JARVIS-Mac' : 'JARVIS-Server');

  const params = new URLSearchParams({
    device: deviceType,
    name: deviceName,
    id: deviceId,
  });
  if (config.token) params.set('token', config.token);

  const url = `${config.url}?${params}`;

  try {
    aimWs = new WebSocket(url);
  } catch (err) {
    console.log(`  [aim] Connection failed: ${(err as Error).message}`);
    scheduleReconnect(config);
    return;
  }

  aimWs.on('open', () => {
    aimConnected = true;
    console.log(`  [aim] Connected to AIM relay as '${deviceType}': ${config.url}`);

    // Register with capabilities
    const capabilities = IS_MAC
      ? ['audio', 'tts', 'systemControl', 'display', 'microphone']
      : ['tts', 'conversation', 'memory', 'modules'];

    sendToAIM({
      type: 'register',
      deviceType,
      deviceName,
      capabilities,
      from: deviceId,
    });

    // Wire up mac-proxy so macOS commands get forwarded through AIM
    if (!IS_MAC) {
      setMacProxySender((msg) => sendToAIM(msg));
    }

    // Start pinging
    pingTimer = setInterval(() => {
      sendToAIM({ type: 'ping' });
    }, 15000);
  });

  aimWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Handle commands from devices
      if (msg.type === 'command' && msg.text) {
        handleAIMCommand(msg).catch((err) => {
          sendToAIM({ type: 'error', message: (err as Error).message, to: msg.from });
          sendToAIM({ type: 'status', state: 'idle' });
        });
      }

      // Handle system_command_result from Mac client (VPS mode)
      if (msg.type === 'system_command_result' && msg.requestId) {
        handleMacProxyResult(msg.requestId, msg.result || '', msg.error);
      }

      // Other message types (pong, ack, devices, etc.)
      if (msg.type === 'ack') {
        console.log(`  [aim] ${msg.message}`);
      }
    } catch { /* ignore */ }
  });

  aimWs.on('close', () => {
    aimConnected = false;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    console.log(`  [aim] Disconnected from AIM relay`);

    // Clear mac-proxy sender on disconnect
    if (!IS_MAC) {
      setMacProxySender(null as any);
    }

    scheduleReconnect(config);
  });

  aimWs.on('error', (err) => {
    console.log(`  [aim] Error: ${err.message}`);
  });
}

function scheduleReconnect(config: AIMBridgeConfig): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToAIM(config);
  }, 5000);
}

// ── Public API ──

export function startAIMBridge(): boolean {
  const config = loadAIMConfig();
  if (!config) {
    console.log(`  [aim] No AIM config found (config/aim.json or AIM_URL env). Skipping remote bridge.`);
    return false;
  }

  console.log(`  [aim] Starting AIM bridge to ${config.url}`);
  connectToAIM(config);
  return true;
}

export function stopAIMBridge(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (aimWs) { aimWs.close(); aimWs = null; }
  aimConnected = false;
}

export function isAIMConnected(): boolean {
  return aimConnected;
}

/**
 * Broadcast a status update through AIM to all connected devices.
 * Used by status-reporter.ts to keep devices in sync.
 */
export function broadcastStatusViaAIM(state: string, extra?: Record<string, any>): void {
  sendToAIM({ type: 'status', state, ...extra });
}
