import { run } from './shell.js';
import { execSync } from 'child_process';

export async function osascript(script: string): Promise<string> {
  // Use -e with single quotes and pipe to avoid escaping issues
  // For multi-line or complex scripts, write to stdin
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

// Synchronous version for cases where we need immediate result
export function osascriptSync(script: string): string {
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
