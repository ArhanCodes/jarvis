import { execSync, exec } from 'child_process';
import { writeFileSync, mkdirSync, unlinkSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SandboxConfig {
  image: string;
  timeout: number;
  memoryLimit: string;
  cpuLimit: string;
  networkEnabled: boolean;
  mountPaths?: string[];
  workdir?: string;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  executionTime: number;
  sandboxed: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SANDBOX_DIR = join(tmpdir(), 'jarvis-sandbox');

const LANGUAGE_DEFAULTS: Record<string, { image: string; ext: string; cmd: (f: string) => string }> = {
  javascript: { image: 'node:20-slim', ext: '.js', cmd: (f) => `node ${f}` },
  node:       { image: 'node:20-slim', ext: '.js', cmd: (f) => `node ${f}` },
  typescript: { image: 'node:20-slim', ext: '.ts', cmd: (f) => `npx --yes tsx ${f}` },
  python:     { image: 'python:3.12-slim', ext: '.py', cmd: (f) => `python3 ${f}` },
  bash:       { image: 'ubuntu:22.04', ext: '.sh', cmd: (f) => `bash ${f}` },
  shell:      { image: 'ubuntu:22.04', ext: '.sh', cmd: (f) => `bash ${f}` },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureSandboxDir(): void {
  if (!existsSync(SANDBOX_DIR)) {
    mkdirSync(SANDBOX_DIR, { recursive: true });
  }
}

function uniqueId(): string {
  return randomBytes(8).toString('hex');
}

function defaultConfig(language?: string): SandboxConfig {
  const lang = language?.toLowerCase() ?? 'javascript';
  const info = LANGUAGE_DEFAULTS[lang] ?? LANGUAGE_DEFAULTS['javascript'];
  return {
    image: info.image,
    timeout: 30,
    memoryLimit: '256m',
    cpuLimit: '1.0',
    networkEnabled: false,
  };
}

function mergeConfig(partial?: Partial<SandboxConfig>, language?: string): SandboxConfig {
  const base = defaultConfig(language);
  return { ...base, ...partial };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether the Docker CLI exists and the daemon is reachable.
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a code snippet in a sandboxed Docker container (or fall back to direct
 * execution when Docker is not available).
 */
export async function runInSandbox(
  code: string,
  language: string,
  config?: Partial<SandboxConfig>,
): Promise<SandboxResult> {
  const lang = language.toLowerCase();
  const info = LANGUAGE_DEFAULTS[lang];
  if (!info) {
    return {
      stdout: '',
      stderr: `Unsupported language: ${language}. Supported: ${Object.keys(LANGUAGE_DEFAULTS).join(', ')}`,
      exitCode: 1,
      timedOut: false,
      executionTime: 0,
      sandboxed: false,
    };
  }

  ensureSandboxDir();
  const id = uniqueId();
  const filename = `script_${id}${info.ext}`;
  const hostPath = join(SANDBOX_DIR, filename);

  try {
    writeFileSync(hostPath, code, 'utf-8');

    const dockerAvailable = await isDockerAvailable();
    if (dockerAvailable) {
      return await runInDocker(hostPath, filename, info.cmd, lang, config);
    }
    return await runDirectly(hostPath, info.cmd, lang, config);
  } finally {
    safeUnlink(hostPath);
  }
}

/**
 * Run an arbitrary shell command inside a sandboxed Docker container (or fall
 * back to direct execution).
 */
export async function runCommandInSandbox(
  command: string,
  config?: Partial<SandboxConfig>,
): Promise<SandboxResult> {
  const cfg = mergeConfig(config, 'bash');

  const dockerAvailable = await isDockerAvailable();
  if (dockerAvailable) {
    return await runDockerCommand(command, cfg);
  }
  return await runDirectCommand(command, cfg);
}

/**
 * Build a custom Docker image from a Dockerfile string.
 */
export async function buildSandboxImage(name: string, dockerfile: string): Promise<boolean> {
  ensureSandboxDir();
  const id = uniqueId();
  const dfPath = join(SANDBOX_DIR, `Dockerfile_${id}`);
  const contextDir = join(SANDBOX_DIR, `ctx_${id}`);

  try {
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(join(contextDir, 'Dockerfile'), dockerfile, 'utf-8');
    execSync(`docker build -t ${name} ${contextDir}`, { stdio: 'pipe', timeout: 300_000 });
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sandbox] Failed to build image "${name}": ${msg}`);
    return false;
  } finally {
    safeUnlink(dfPath);
    safeRm(contextDir);
  }
}

/**
 * Clean up temp files and stopped jarvis-sandbox containers.
 */
export function cleanupSandbox(): void {
  // Remove temp directory contents
  if (existsSync(SANDBOX_DIR)) {
    try {
      rmSync(SANDBOX_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  // Remove stopped sandbox containers
  try {
    const containers = execSync(
      'docker ps -a --filter "label=jarvis-sandbox" -q',
      { stdio: 'pipe', timeout: 5000 },
    ).toString().trim();
    if (containers) {
      execSync(`docker rm -f ${containers.split('\n').join(' ')}`, { stdio: 'pipe', timeout: 10_000 });
    }
  } catch { /* Docker may not be available */ }
}

// ---------------------------------------------------------------------------
// Internal — Docker execution
// ---------------------------------------------------------------------------

function runInDocker(
  hostPath: string,
  filename: string,
  cmdFn: (f: string) => string,
  language: string,
  partial?: Partial<SandboxConfig>,
): Promise<SandboxResult> {
  const cfg = mergeConfig(partial, language);
  const containerScript = `/sandbox/${filename}`;

  const args: string[] = [
    'docker', 'run', '--rm',
    '--label', 'jarvis-sandbox',
    '--memory', cfg.memoryLimit,
    '--cpus', cfg.cpuLimit,
  ];

  if (!cfg.networkEnabled) {
    args.push('--network', 'none');
  }

  // Mount the sandbox directory read-only
  args.push('-v', `${SANDBOX_DIR}:/sandbox:ro`);

  // Additional read-only mounts
  if (cfg.mountPaths) {
    for (const mp of cfg.mountPaths) {
      args.push('-v', `${mp}:${mp}:ro`);
    }
  }

  args.push('--workdir', cfg.workdir ?? '/sandbox');
  args.push(cfg.image);

  // The actual command to run inside the container
  const innerCmd = cmdFn(containerScript);
  args.push('sh', '-c', innerCmd);

  return execWithTimeout(args.join(' '), cfg.timeout, true);
}

function runDockerCommand(command: string, cfg: SandboxConfig): Promise<SandboxResult> {
  const args: string[] = [
    'docker', 'run', '--rm',
    '--label', 'jarvis-sandbox',
    '--memory', cfg.memoryLimit,
    '--cpus', cfg.cpuLimit,
  ];

  if (!cfg.networkEnabled) {
    args.push('--network', 'none');
  }

  args.push('--workdir', cfg.workdir ?? '/tmp');
  args.push(cfg.image);
  args.push('sh', '-c', command);

  return execWithTimeout(args.join(' '), cfg.timeout, true);
}

// ---------------------------------------------------------------------------
// Internal — Direct (fallback) execution
// ---------------------------------------------------------------------------

function runDirectly(
  hostPath: string,
  cmdFn: (f: string) => string,
  language: string,
  partial?: Partial<SandboxConfig>,
): Promise<SandboxResult> {
  const cfg = mergeConfig(partial, language);
  const cmd = cmdFn(hostPath);
  return execWithTimeout(cmd, cfg.timeout, false);
}

function runDirectCommand(command: string, cfg: SandboxConfig): Promise<SandboxResult> {
  return execWithTimeout(command, cfg.timeout, false);
}

// ---------------------------------------------------------------------------
// Internal — Execution wrapper
// ---------------------------------------------------------------------------

function execWithTimeout(command: string, timeoutSec: number, sandboxed: boolean): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const timeoutMs = timeoutSec * 1000;
    let timedOut = false;

    const child = exec(command, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const executionTime = Date.now() - start;

      if (error && (error as any).killed) {
        timedOut = true;
      }

      resolve({
        stdout: (stdout ?? '').toString().trim(),
        stderr: (stderr ?? '').toString().trim(),
        exitCode: error ? (error as any).code ?? 1 : 0,
        timedOut,
        executionTime,
        sandboxed,
      });
    });

    // Safety net: force-kill if still alive after timeout + grace period
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }, timeoutMs + 2000);
  });
}

// ---------------------------------------------------------------------------
// Internal — Cleanup helpers
// ---------------------------------------------------------------------------

function safeUnlink(p: string): void {
  try { unlinkSync(p); } catch { /* ignore */ }
}

function safeRm(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}
