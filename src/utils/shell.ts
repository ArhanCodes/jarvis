import { exec, ExecOptions } from 'child_process';

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
  /rm\s+-rf?\s+~\//,
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
      shell: '/bin/zsh',
    };
    exec(command, opts, (error, stdout, stderr) => {
      resolve({
        stdout: (stdout ?? '').toString().trim(),
        stderr: (stderr ?? '').toString().trim(),
        exitCode: error ? (error as NodeJS.ErrnoException).code ? 1 : 1 : 0,
      });
    });
  });
}
