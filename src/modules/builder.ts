import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { claudeAgentLoop, isLLMAvailable, type AgentToolDef } from '../utils/llm.js';
import { fmt } from '../utils/formatter.js';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, resolve, relative, dirname, sep } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

// Fable 5 is the default "max brain" model for builds (falls back to Opus 4.8
// automatically inside claudeAgentLoop if Fable isn't available on the account).
const BUILDER_MODEL = 'claude-fable-5';
const PROJECTS_DIR = join(homedir(), 'Desktop', 'JarvisProjects');
const BASH_TIMEOUT_MS = 180_000;
const MAX_TOOL_OUTPUT = 16_000;

// Safety net for the autonomous bash tool. Not a sandbox — cwd is pinned to the
// project dir and these obviously-destructive shapes are refused outright.
const DANGEROUS: RegExp[] = [
  // rm with any recursive/force flag — short (-rf, -R) OR long (--recursive,
  // --force) — aimed at an absolute path, home, parent dir, or a bare glob.
  // Relative deletes inside the project (rm -rf node_modules, rm -rf dist/) stay allowed.
  /\brm\b[^\n]*(?:-[a-zA-Z]*[rf]|--recursive|--force)[^\n]*\s(?:\/|~|\.\.|\*)/i,
  /:\(\)\s*\{.*\|.*&\s*\}/,     // fork bomb
  /\bmkfs\b/i,
  /\bdd\b[^\n]*\bof=\/dev\//i,
  /\bsudo\b/i,
  /\b(shutdown|reboot|halt)\b/i,
  /\bkillall\b/i,
  />\s*\/dev\/(sd|disk|null\/)/i,
];

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'project';
}

// Confine a model-supplied path to the project directory (blocks .., abs paths,
// symlink-escape via resolve()).
function safePath(projectDir: string, p: string): string {
  const full = resolve(projectDir, p || '.');
  if (full !== projectDir && !full.startsWith(projectDir + sep)) {
    throw new Error(`Path escapes the project directory: ${p}`);
  }
  return full;
}

const TOOLS: AgentToolDef[] = [
  {
    name: 'write_file',
    description: 'Create or overwrite a file. Parent directories are created automatically. Path is relative to the project directory.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the project.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace the first exact occurrence of old_string with new_string in a file.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'run_bash',
    description: 'Run a shell command in the project directory. Use it to install dependencies, run the app, run tests, use git, etc.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'list_dir',
    description: 'List files and folders. Path defaults to the project root.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
    },
  },
];

function makeRunTool(projectDir: string) {
  return async (name: string, input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> => {
    try {
      if (name === 'write_file') {
        const full = safePath(projectDir, String(input.path ?? ''));
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, String(input.content ?? ''), 'utf-8');
        return { content: `Wrote ${input.path}` };
      }
      if (name === 'read_file') {
        const full = safePath(projectDir, String(input.path ?? ''));
        if (!existsSync(full)) return { content: `File not found: ${input.path}`, isError: true };
        return { content: readFileSync(full, 'utf-8').slice(0, MAX_TOOL_OUTPUT) };
      }
      if (name === 'edit_file') {
        const full = safePath(projectDir, String(input.path ?? ''));
        if (!existsSync(full)) return { content: `File not found: ${input.path}`, isError: true };
        const cur = readFileSync(full, 'utf-8');
        const oldS = String(input.old_string ?? '');
        if (!cur.includes(oldS)) return { content: `old_string not found in ${input.path}`, isError: true };
        writeFileSync(full, cur.replace(oldS, String(input.new_string ?? '')), 'utf-8');
        return { content: `Edited ${input.path}` };
      }
      if (name === 'run_bash') {
        const cmd = String(input.command ?? '');
        if (DANGEROUS.some((re) => re.test(cmd))) {
          return { content: `Refused: that command looks destructive and was not run: ${cmd}`, isError: true };
        }
        try {
          const out = execSync(cmd, {
            cwd: projectDir,
            timeout: BASH_TIMEOUT_MS,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, CI: '1', GIT_TERMINAL_PROMPT: '0' },
          });
          return { content: (out || '(no output)').slice(0, MAX_TOOL_OUTPUT) };
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; message?: string };
          const out = ((e.stdout || '') + (e.stderr || '')) || e.message || 'command failed';
          return { content: out.slice(0, MAX_TOOL_OUTPUT), isError: true };
        }
      }
      if (name === 'list_dir') {
        const full = safePath(projectDir, String(input.path ?? '.'));
        if (!existsSync(full)) return { content: `Not found: ${input.path ?? '.'}`, isError: true };
        const entries = readdirSync(full).map((e) => {
          try { return statSync(join(full, e)).isDirectory() ? `${e}/` : e; } catch { return e; }
        });
        return { content: entries.join('\n') || '(empty)' };
      }
      return { content: `Unknown tool: ${name}`, isError: true };
    } catch (err) {
      return { content: `Error: ${(err as Error).message}`, isError: true };
    }
  };
}

function buildSystemPrompt(projectDir: string): string {
  return `You are JARVIS in build mode — an autonomous software engineer working like Claude Code. You have these tools: write_file, read_file, edit_file, run_bash, list_dir.

Working directory: ${projectDir}
Every path you pass is relative to this directory, and everything you create lives inside it.

How to work:
- Build the project the user asked for, end to end. Do not stop to ask for confirmation — you are operating autonomously and the user is not watching in real time. Reversible actions that follow from the request: just do them.
- Pick sensible, simple tech and keep the project minimal but real (no placeholder TODOs). Install dependencies with run_bash when you need them.
- Actually run the project (or its build/tests) with run_bash to verify it works, read the output, and fix what you find. Iterate until it genuinely runs.
- Narrate lightly: one short line when you start a phase or hit a blocker. Do not narrate routine tool calls.
- Never run destructive commands, sudo, or anything that reaches outside the working directory.

When you're done, end your turn with a short summary: what you built, exactly how to run it, and the key files. Lead with the outcome.`;
}

export interface BuildEvent { kind: 'tool' | 'tool-error' | 'info'; text: string; }
export interface BuildResult { ok: boolean; summary: string; projectDir: string; steps: number; usedModel: string; }

/**
 * Run an autonomous, Claude-Code-style build in a fresh project directory under
 * ~/Desktop/JarvisProjects. Streams assistant narration via onText and tool
 * activity via onEvent. Shared by the CLI (BuilderModule.execute) and the watch
 * WebSocket server (handleBuild).
 */
export async function runBuild(
  description: string,
  opts: { onText: (t: string) => void; onEvent?: (e: BuildEvent) => void; model?: string },
): Promise<BuildResult> {
  mkdirSync(PROJECTS_DIR, { recursive: true });
  // Non-recursive mkdir throws EEXIST atomically, so two identical builds fired
  // in the same millisecond get distinct directories instead of clobbering.
  const base = join(PROJECTS_DIR, `${slugify(description)}-${Date.now().toString(36)}`);
  let dir = base;
  for (let i = 1; ; i++) {
    try { mkdirSync(dir); break; }
    catch { dir = `${base}-${i}`; }
  }

  const result = await claudeAgentLoop(
    `Build this in the working directory: ${description}`,
    TOOLS,
    {
      system: buildSystemPrompt(dir),
      model: opts.model || BUILDER_MODEL,
      maxSteps: 60,
      maxTokens: 16_000,
      runTool: makeRunTool(dir),
      onText: opts.onText,
      onToolStart: (name, input) => {
        const detail = name === 'run_bash' ? String(input.command || '') : String(input.path || '');
        opts.onEvent?.({ kind: 'tool', text: `${name}: ${detail}`.slice(0, 160) });
      },
      onToolEnd: (name, preview, isError) => {
        if (isError) opts.onEvent?.({ kind: 'tool-error', text: `${name} error: ${preview.slice(0, 120)}` });
      },
    },
  );

  const ok = result.stopReason !== 'refusal' && result.stopReason !== 'max_steps';
  return {
    ok,
    summary: result.text.trim() || (ok ? 'Build complete.' : 'Build did not finish.'),
    projectDir: dir,
    steps: result.steps,
    usedModel: result.model,
  };
}

export class BuilderModule implements JarvisModule {
  name = 'builder' as const;
  description = 'Autonomous project builder — a Claude Code-style agent (Fable) that writes files and runs commands';

  patterns: PatternDefinition[] = [
    {
      intent: 'build',
      patterns: [
        /^build\s+(?:me\s+)?(?:a\s+|an\s+|the\s+)?(.+)/i,
        /^(?:make|create|scaffold)\s+(?:me\s+)?(?:a\s+|an\s+)?(.+?\s+(?:project|app|website|site|api|server|tool|script|game|bot|cli|extension))$/i,
      ],
      extract: (m) => ({ description: (m[1] || '').trim() }),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    if (command.action !== 'build') return { success: false, message: `Unknown action: ${command.action}` };
    const description = command.args.description;
    if (!description) {
      return { success: false, message: 'Build what? Try: build a snake game in python.' };
    }
    if (!(await isLLMAvailable())) {
      return { success: false, message: 'Claude API is not configured. Set your API key in config/llm-config.json.' };
    }

    process.stdout.write(fmt.dim(`  [build] Fable is building: ${description}\n`));
    process.stdout.write('  ');
    const res = await runBuild(description, {
      onText: (t) => process.stdout.write(t),
      onEvent: (e) => process.stdout.write(fmt.dim(`\n  [${e.text}]\n  `)),
    });
    process.stdout.write('\n\n');
    process.stdout.write(
      fmt.success(`  Built in ${res.projectDir} (${res.steps} steps, ${res.usedModel.replace('claude-', '')})\n`),
    );

    return {
      success: res.ok,
      message: '',
      streamed: true,
      voiceMessage: res.ok
        ? "I've finished building it, sir. It's on your desktop in Jarvis Projects."
        : "I couldn't finish the build, sir.",
      data: { projectDir: res.projectDir },
    };
  }

  getHelp(): string {
    return [
      '  Build (autonomous agent) -- powered by Fable',
      '    build <description>       Build a whole project like Claude Code',
      '    build a snake game in python',
      '    build me a landing page for a coffee shop',
    ].join('\n');
  }
}
