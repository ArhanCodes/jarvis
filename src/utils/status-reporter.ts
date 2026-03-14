import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { IS_MAC } from './platform.js';

// ── Status Reporter ──
// Writes JARVIS state to /tmp/jarvis-status.json for the menubar app to read.
// Also broadcasts via AIM so all connected devices see state changes.

const STATUS_PATH = '/tmp/jarvis-status.json';

interface JarvisStatusData {
  running: boolean;
  voiceActive: boolean;
  state: string;          // idle, activated, processing, speaking
  lastCommand: string;
  lastCommandTime: number;
  modulesLoaded: number;
  pid: number;
}

const currentStatus: JarvisStatusData = {
  running: false,
  voiceActive: false,
  state: 'idle',
  lastCommand: '',
  lastCommandTime: 0,
  modulesLoaded: 0,
  pid: process.pid,
};

let statusCallback: ((status: JarvisStatusData) => void) | null = null;
let aimBroadcast: ((state: string, extra?: Record<string, any>) => void) | null = null;

/**
 * Register a callback for real-time status updates (used by watch server).
 */
export function onStatusUpdate(cb: (status: JarvisStatusData) => void): void {
  statusCallback = cb;
}

/**
 * Register the AIM broadcast function for pushing status to all devices.
 */
export function setAIMStatusBroadcast(fn: (state: string, extra?: Record<string, any>) => void): void {
  aimBroadcast = fn;
}

function flush(): void {
  // Write local status file (for menubar app on Mac)
  if (IS_MAC) {
    try {
      writeFileSync(STATUS_PATH, JSON.stringify(currentStatus));
    } catch { /* ignore write errors */ }
  }
  // Push to watch server if connected
  statusCallback?.(currentStatus);
  // Broadcast via AIM to all connected devices
  aimBroadcast?.(currentStatus.state, {
    lastCommand: currentStatus.lastCommand,
    voiceActive: currentStatus.voiceActive,
  });
}

export function reportBoot(moduleCount: number): void {
  currentStatus.running = true;
  currentStatus.modulesLoaded = moduleCount;
  currentStatus.pid = process.pid;
  flush();
}

export function reportVoice(active: boolean): void {
  currentStatus.voiceActive = active;
  if (!active) currentStatus.state = 'idle';
  flush();
}

export function reportState(state: string): void {
  currentStatus.state = state;
  flush();
}

export function reportCommand(command: string): void {
  currentStatus.lastCommand = command;
  currentStatus.lastCommandTime = Date.now();
  flush();
}

export function reportShutdown(): void {
  currentStatus.running = false;
  currentStatus.state = 'idle';
  flush();
  // Clean up the status file
  try {
    if (existsSync(STATUS_PATH)) unlinkSync(STATUS_PATH);
  } catch { /* ignore */ }
}
