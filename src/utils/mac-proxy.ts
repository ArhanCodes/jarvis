/**
 * Mac Proxy — Routes macOS commands to a connected Mac client via AIM.
 *
 * When JARVIS runs on a Linux VPS, macOS-specific operations (osascript,
 * afplay, say, etc.) cannot execute locally. Instead, this module sends
 * them to the connected Mac client through AIM, waits for the result,
 * and returns it as if it ran locally.
 */

import { randomUUID } from 'crypto';

// These are set by aim-bridge.ts when it connects
let sendFn: ((msg: Record<string, unknown>) => void) | null = null;
const pendingRequests = new Map<string, {
  resolve: (result: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}>();

/**
 * Called by aim-bridge.ts to wire up the send function.
 */
export function setMacProxySender(fn: (msg: Record<string, unknown>) => void): void {
  sendFn = fn;
}

/**
 * Called by aim-bridge.ts when a system_command_result arrives from the Mac.
 */
export function handleMacProxyResult(requestId: string, result: string, error?: string): void {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRequests.delete(requestId);

  if (error) {
    pending.reject(new Error(error));
  } else {
    pending.resolve(result);
  }
}

/**
 * Check if a Mac client is connected and proxy is available.
 */
export function isMacConnected(): boolean {
  return sendFn !== null;
}

/**
 * Send an osascript command to the Mac for execution.
 */
export async function proxyOsascript(script: string): Promise<string> {
  if (!sendFn) {
    throw new Error('Mac is not connected — cannot run AppleScript');
  }

  const requestId = `proxy-${randomUUID().slice(0, 8)}`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Mac proxy timeout — no response after 15s'));
    }, 15000);

    pendingRequests.set(requestId, { resolve, reject, timer });

    sendFn!({
      type: 'system_command',
      command: 'osascript',
      script,
      requestId,
      to: 'mac',
    });
  });
}

/**
 * Send a shell command to the Mac for execution.
 */
export async function proxyShell(command: string): Promise<string> {
  if (!sendFn) {
    throw new Error('Mac is not connected — cannot run shell command');
  }

  const requestId = `proxy-${randomUUID().slice(0, 8)}`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Mac proxy timeout — no response after 15s'));
    }, 15000);

    pendingRequests.set(requestId, { resolve, reject, timer });

    sendFn!({
      type: 'system_command',
      command: 'shell',
      script: command,
      requestId,
      to: 'mac',
    });
  });
}

/**
 * Tell the Mac client to play audio from base64 data.
 */
export function proxyPlayAudio(base64Audio: string): void {
  if (!sendFn) return;
  sendFn({
    type: 'play_audio',
    data: base64Audio,
    to: 'mac',
  });
}
