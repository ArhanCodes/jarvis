import { run } from './shell.js';
import { execSync } from 'child_process';
import { IS_MAC } from './platform.js';
import { proxyOsascript } from './mac-proxy.js';

export async function osascript(script: string): Promise<string> {
  // On Linux (VPS), proxy the command to the connected Mac client via AIM
  if (!IS_MAC) {
    return proxyOsascript(script);
  }

  // On macOS, run locally
  const escaped = script
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  const result = await run(`osascript -e "${escaped}"`);
  if (result.exitCode !== 0 && result.stderr) {
    throw new Error(`AppleScript error: ${result.stderr}`);
  }
  return result.stdout;
}

// Synchronous version — can't proxy synchronously, returns empty on non-Mac
export function osascriptSync(script: string): string {
  if (!IS_MAC) return '';

  try {
    return execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
  } catch {
    return '';
  }
}

export async function getRunningApps(): Promise<string[]> {
  const raw = await osascript(
    'tell application "System Events" to get name of every process whose background only is false'
  );
  return raw.split(', ').map(s => s.trim()).filter(Boolean);
}

export async function activateApp(name: string): Promise<void> {
  await osascript(`tell application "${name}" to activate`);
}

export async function quitApp(name: string): Promise<void> {
  await osascript(`tell application "${name}" to quit`);
}

export async function getFrontmostApp(): Promise<string> {
  return osascript(
    'tell application "System Events" to get the name of the first process whose frontmost is true'
  );
}
