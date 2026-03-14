import { exec, ExecOptions } from 'child_process';
import { IS_MAC } from './platform.js';

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DANGEROUS_PATTERNS = [
  /rm\s+(-rf?|--recursive)\s+\//,
  /sudo\s+rm/,
  /mkfs/,
  /dd\s+if=/,
  />\s*\/dev\/sd/,
  /:\(\)\{.*\|.*&\s*\};/,
  /rm\s+-rf?\s+~\s*$/,
  /rm\s+-rf?\s+~\//,
  /chmod\s+-R\s+777\s+\//,
  />\s*\/etc\//,
  /launchctl\s+unload/,
];

export function isSafe(command: string): boolean {
  return !DANGEROUS_PATTERNS.some(p => p.test(command));
}

export async function run(
  command: string,
  options?: { timeout?: number; cwd?: string }
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const opts: ExecOptions = {
      timeout: options?.timeout ?? 30000,
      cwd: options?.cwd,
      maxBuffer: 1024 * 1024 * 10,
      shell: IS_MAC ? '/bin/zsh' : '/bin/bash',
    };
    exec(command, opts, (error, stdout, stderr) => {
      let exitCode = 0;
      if (error) {
        const errWithCode = error as NodeJS.ErrnoException & { status?: number };
        exitCode = errWithCode.status ?? (typeof errWithCode.code === 'number' ? errWithCode.code : 1);
      }
      resolve({
        stdout: (stdout ?? '').toString().trim(),
        stderr: (stderr ?? '').toString().trim(),
        exitCode,
      });
    });
  });
}
