#!/usr/bin/env node
/**
 * JARVIS Mac Client
 *
 * Thin client that runs on the Mac when JARVIS brain is on the VPS.
 * Connects to AIM relay as device type 'mac' and:
 * - Executes macOS commands forwarded from VPS (osascript, shell)
 * - Plays audio received from VPS (TTS via afplay)
 * - Provides readline for typed commands → sent to VPS
 * - Supports voice assistant (say "Jarvis") → sent to VPS
 * - Writes status to /tmp/jarvis-status.json for menubar app
 * - Launches menubar app on start
 *
 * Usage:
 *   npx tsx src/mac-client.ts
 */

import * as readline from 'readline';
import WebSocket from 'ws';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, existsSync, unlinkSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { reportBoot, reportVoice, reportState, reportShutdown } from './utils/status-reporter.js';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──

interface MacClientConfig {
  url: string;
  token?: string;
  deviceName?: string;
}

function loadConfig(): MacClientConfig {
  const paths = [
    join(__dirname, '..', 'config', 'aim.json'),
    join(__dirname, '..', '..', 'config', 'aim.json'),
  ];

  for (const p of paths) {
    try {
      if (existsSync(p)) {
        const config = JSON.parse(readFileSync(p, 'utf-8'));
        if (config.url) return config;
      }
    } catch { /* ignore */ }
  }

  return {
    url: process.env.AIM_URL || 'ws://localhost:5225',
    token: process.env.AIM_TOKEN,
    deviceName: process.env.AIM_DEVICE_NAME || 'JARVIS-Mac',
  };
}

// ── Status ──

const STATUS_PATH = '/tmp/jarvis-status.json';

function writeStatus(state: string, extra?: Record<string, any>): void {
  try {
    writeFileSync(STATUS_PATH, JSON.stringify({
      running: true,
      state,
      pid: process.pid,
      mode: 'mac-client',
      ...extra,
    }));
  } catch { /* ignore */ }
}

// ── Audio queue for sequential playback ──

let audioPlaying = false;
const audioQueue: string[] = [];

async function playNextAudio(): Promise<void> {
  if (audioPlaying || audioQueue.length === 0) return;
  audioPlaying = true;

  const base64 = audioQueue.shift()!;
  const tmpFile = join(tmpdir(), `jarvis-mac-audio-${Date.now()}.mp3`);

  try {
    const buffer = Buffer.from(base64, 'base64');
    writeFileSync(tmpFile, buffer);
    await execAsync(`afplay "${tmpFile}"`);
  } catch (err) {
    console.log(`  [mac] Audio playback error: ${(err as Error).message}`);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ok */ }
    audioPlaying = false;
    playNextAudio(); // Play next in queue
  }
}

// ── WebSocket Client ──

let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let connected = false;
let streamingResponse = false;

function send(msg: Record<string, unknown>): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

async function handleSystemCommand(msg: any): Promise<void> {
  const { command, script, requestId } = msg;

  console.log(`  [mac] System command: ${command} (${requestId})`);

  try {
    let result = '';

    if (command === 'osascript') {
      const escaped = script.replace(/'/g, "'\\''");
      const { stdout } = await execAsync(`osascript -e '${escaped}'`, { timeout: 15000 });
      result = stdout.trim();
    } else if (command === 'shell') {
      const { stdout } = await execAsync(script, { timeout: 15000, shell: '/bin/zsh' });
      result = stdout.trim();
    }

    send({
      type: 'system_command_result',
      requestId,
      result,
      to: 'server',
    });

    console.log(`  [mac] Result: ${result.slice(0, 100)}${result.length > 100 ? '...' : ''}`);
  } catch (err) {
    const errorMsg = (err as Error).message;
    console.log(`  [mac] Command error: ${errorMsg}`);

    send({
      type: 'system_command_result',
      requestId,
      result: '',
      error: errorMsg,
      to: 'server',
    });
  }
}

function sendCommand(text: string): void {
  if (!connected) {
    console.log('  [mac] Not connected to VPS. Waiting...');
    return;
  }

  send({
    type: 'command',
    text,
    respondTo: 'jarvis-mac',
    playOnMac: true,  // Play audio on this Mac
    from: 'jarvis-mac',
  });
}

function connect(config: MacClientConfig): void {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  const params = new URLSearchParams({
    device: 'mac',
    name: config.deviceName || 'JARVIS-Mac',
    id: 'jarvis-mac',
  });
  if (config.token) params.set('token', config.token);

  const url = `${config.url}?${params}`;

  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.log(`  [mac] Connection failed: ${(err as Error).message}`);
    scheduleReconnect(config);
    return;
  }

  ws.on('open', () => {
    connected = true;
    console.log(`  [mac] Connected to AIM relay: ${config.url}`);
    writeStatus('connected');
    reportBoot(0); // Sync status-reporter so voice-assistant flushes don't clobber running=true

    send({
      type: 'register',
      deviceType: 'mac',
      deviceName: config.deviceName || 'JARVIS-Mac',
      capabilities: ['audio', 'systemControl', 'display', 'microphone'],
      from: 'jarvis-mac',
    });

    pingTimer = setInterval(() => {
      send({ type: 'ping' });
    }, 15000);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'system_command':
          handleSystemCommand(msg).catch(console.error);
          break;

        case 'play_audio':
          audioQueue.push(msg.data);
          playNextAudio();
          break;

        case 'audio':
          // Streamed audio chunk from VPS
          audioQueue.push(msg.data);
          playNextAudio();
          break;

        case 'audioEnd':
          // Audio stream finished
          break;

        case 'token':
          // Streaming response token — print it live
          if (!streamingResponse) {
            streamingResponse = true;
            process.stdout.write('\n  ');
          }
          process.stdout.write(msg.text || '');
          break;

        case 'status':
          writeStatus(msg.state, {
            lastCommand: msg.lastCommand,
            voiceActive: msg.voiceActive,
          });
          reportState(msg.state); // Keep status-reporter in sync
          if (msg.state === 'idle') {
            if (streamingResponse) {
              streamingResponse = false;
              process.stdout.write('\n\n');
              rl?.prompt();
            }
            // Reset voice assistant so it listens for next wake word
            resetVoiceAfterVPSResponse();
          }
          break;

        case 'ack':
          console.log(`  [mac] ${msg.message}`);
          break;

        case 'pong':
          break;

        default:
          break;
      }
    } catch { /* ignore */ }
  });

  ws.on('close', () => {
    connected = false;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    console.log(`  [mac] Disconnected from AIM relay`);
    writeStatus('offline');
    scheduleReconnect(config);
  });

  ws.on('error', (err) => {
    console.log(`  [mac] Error: ${err.message}`);
  });
}

function scheduleReconnect(config: MacClientConfig): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(config);
  }, 5000);
}

// ── Voice Assistant ──

let voiceAssistantRunning = false;
let voiceAssistantInstance: any = null;

async function startVoiceAssistant(): Promise<void> {
  if (voiceAssistantRunning) {
    console.log('  Voice assistant is already running.');
    return;
  }

  try {
    const { VoiceAssistant } = await import('./voice/voice-assistant.js');

    voiceAssistantInstance = new VoiceAssistant();

    // Send voice commands to VPS instead of processing locally
    voiceAssistantInstance.onCommand((text: string) => {
      console.log(`\n  [voice] "${text}" → VPS`);
      sendCommand(text);
    });

    await voiceAssistantInstance.start();
    voiceAssistantRunning = true;
    reportVoice(true);
    console.log('  ✓ Voice assistant started. Say "Jarvis" to activate.');
  } catch (err) {
    console.log(`  ✗ Voice assistant failed: ${(err as Error).message}`);
    console.log('    (Requires macOS with Xcode Command Line Tools)');
  }
}

function stopVoiceAssistant(): void {
  if (voiceAssistantInstance) {
    voiceAssistantInstance.stop();
    voiceAssistantInstance = null;
    voiceAssistantRunning = false;
    console.log('  ✓ Voice assistant stopped.');
  } else {
    console.log('  Voice assistant is not running.');
  }
}

/**
 * Called when VPS reports idle — reset voice assistant so it can listen again.
 */
function resetVoiceAfterVPSResponse(): void {
  if (voiceAssistantInstance && voiceAssistantRunning) {
    voiceAssistantInstance.resetToIdle();
  }
}

// ── Readline ──

let rl: readline.Interface | null = null;

// ── Main ──

function main(): void {
  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║     JARVIS Mac Client                ║');
  console.log('  ║     Thin client for VPS mode         ║');
  console.log('  ╚══════════════════════════════════════╝\n');

  const config = loadConfig();
  console.log(`  [mac] Connecting to AIM at ${config.url}`);

  writeStatus('connecting');
  connect(config);

  // Launch menubar app if available
  const menubarScript = join(__dirname, '..', 'menubar', 'start-menubar.sh');
  if (existsSync(menubarScript)) {
    exec(`bash "${menubarScript}"`, { cwd: dirname(menubarScript) });
    console.log(`  [mac] Launched menubar app`);
  }

  // ── Interactive readline ──
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '  JARVIS > ',
  });

  rl.prompt();

  rl.on('line', (line) => {
    const input = line.trim();
    if (!input) { rl?.prompt(); return; }

    // Local commands
    if (/^(exit|quit|q)$/i.test(input)) {
      cleanup();
      return;
    }

    if (/^voice\s+on$/i.test(input)) {
      startVoiceAssistant().then(() => rl?.prompt());
      return;
    }

    if (/^voice\s+off$/i.test(input)) {
      stopVoiceAssistant();
      rl?.prompt();
      return;
    }

    if (/^voice\s+status$/i.test(input)) {
      console.log(`  Voice: ${voiceAssistantRunning ? 'active (listening)' : 'inactive'}`);
      console.log(`  VPS: ${connected ? 'connected' : 'disconnected'}`);
      rl?.prompt();
      return;
    }

    if (/^status$/i.test(input)) {
      console.log(`  VPS: ${connected ? 'connected' : 'disconnected'}`);
      console.log(`  Voice: ${voiceAssistantRunning ? 'active' : 'inactive'}`);
      rl?.prompt();
      return;
    }

    // Everything else → send to VPS JARVIS
    sendCommand(input);
  });

  rl.on('close', () => {
    cleanup();
  });

  // Graceful shutdown
  const cleanup = () => {
    console.log('\n  [mac] Shutting down...');
    if (voiceAssistantInstance) voiceAssistantInstance.stop();
    if (pingTimer) clearInterval(pingTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) ws.close();
    writeStatus('offline');
    reportShutdown();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGHUP', cleanup);
}

main();
