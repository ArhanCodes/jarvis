import { run } from './shell.js';

export async function osascript(script: string): Promise<string> {
  const escaped = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const result = await run(`osascript -e "${escaped}"`);
  if (result.exitCode !== 0 && result.stderr) {
    throw new Error(`AppleScript error: ${result.stderr}`);
  }
  return result.stdout;
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
