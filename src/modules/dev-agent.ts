import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { llmStreamChat } from '../utils/llm.js';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PROJECTS_DIR = join(homedir(), 'Desktop', 'JarvisProjects');

interface ProjectFile {
  path: string;
  content: string;
}

interface ProjectPlan {
  name: string;
  tech: 'node' | 'python';
  files: ProjectFile[];
  install: string;
  run: string;
}

const PLAN_SYSTEM_PROMPT = `You are a senior software engineer. The user will describe a project. You must respond with ONLY valid JSON (no markdown, no backticks, no explanation) in this exact format:
{
  "name": "project-name-kebab-case",
  "tech": "node" or "python",
  "files": [
    {"path": "relative/file/path", "content": "full file content"}
  ],
  "install": "npm install" or "pip install -r requirements.txt",
  "run": "node index.js" or "python main.py"
}

Rules:
- Keep it MINIMAL — use as few files as possible. Prefer single-file apps when feasible.
- For web apps: use a single HTML file with inline CSS/JS, or at most 2-3 files. Do NOT use React/Vue/Angular unless explicitly asked — use vanilla HTML/CSS/JS.
- All file content must be complete, working code — no placeholders
- The project must run immediately after install with zero manual setup
- Keep the project name short in kebab-case
- Keep total JSON response under 4000 characters`;

const CODE_SYSTEM_PROMPT = `You are a senior software engineer. Write clean, well-commented, production-quality code. Respond with ONLY the code — no markdown fences, no explanations before or after. Just the raw code.`;

const EXPLAIN_SYSTEM_PROMPT = `You are a senior software engineer and teacher. Explain the given code clearly and concisely. Cover:
- What the code does at a high level
- Key functions/classes and their purpose
- Notable patterns or techniques used
- Potential issues or improvements
Keep it conversational but technical.`;

const FIX_SYSTEM_PROMPT = `You are a senior software engineer and debugger. The user will provide code and an error message. Respond with ONLY the fixed code — no markdown fences, no explanations. Just the corrected raw code.`;

function ensureProjectsDir(): void {
  if (!existsSync(PROJECTS_DIR)) {
    mkdirSync(PROJECTS_DIR, { recursive: true });
  }
}

function parsePlan(raw: string): ProjectPlan {
  let cleaned = raw.trim();
  // Strip markdown fences
  if (cleaned.includes('```')) {
    const jsonBlock = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (jsonBlock) cleaned = jsonBlock[1];
  }
  // Try to extract JSON object if there's surrounding text
  if (!cleaned.startsWith('{')) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      cleaned = cleaned.slice(start, end + 1);
    }
  }
  return JSON.parse(cleaned) as ProjectPlan;
}

function writeProjectFiles(projectDir: string, files: ProjectFile[]): void {
  for (const file of files) {
    const filePath = join(projectDir, file.path);
    const dir = join(filePath, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, file.content, 'utf-8');
  }
}

function runCommand(cmd: string, cwd: string, timeoutMs = 30_000): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1' },
    });
    return { ok: true, output: output ?? '' };
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string; killed?: boolean };
    const output = (e.stdout || '') + (e.stderr || '');
    // If process was killed by timeout but printed a listening URL, it's a server — count as success
    if (e.killed && /listening|running|started|http:\/\/localhost/i.test(output)) {
      return { ok: true, output };
    }
    return { ok: false, output: output || e.message || 'Unknown error' };
  }
}

export class DevAgentModule implements JarvisModule {
  name = 'dev-agent' as const;
  description = 'Autonomous project generator — builds, fixes, and runs full projects from a description';

  patterns: PatternDefinition[] = [
    {
      intent: 'generate',
      patterns: [
        /^build\s+me\s+(?:a\s+)?(.+)/i,
        /^create\s+(?:a\s+)?(.+?)\s+(?:project|app|website|site|api|server|tool|script)$/i,
        /^generate\s+(?:a\s+)?(.+?)\s+(?:project|app|website|site|api|server|tool|script)$/i,
        /^scaffold\s+(.+)/i,
      ],
      extract: (match) => ({ description: match[1].trim() }),
    },
    {
      intent: 'write-code',
      patterns: [
        /^write\s+code\s+for\s+(.+)/i,
        /^code\s+(.+)/i,
        /^write\s+(.+)/i,
      ],
      extract: (_match, raw) => {
        // Check if a filepath is specified after "to" or "at"
        const toMatch = raw.match(/(?:to|at|in)\s+([\w\/\.\-~]+)\s*$/i);
        const description = _match[1].trim();
        return { description, filepath: toMatch ? toMatch[1] : '' };
      },
    },
    {
      intent: 'explain',
      patterns: [
        /^explain\s+(?:this\s+code\s+)?(.+)/i,
        /^what\s+does\s+(.+?)\s+do$/i,
      ],
      extract: (match) => ({ filepath: match[1].trim() }),
    },
    {
      intent: 'fix',
      patterns: [
        /^fix\s+(?:the\s+code\s+in\s+)?(.+)/i,
        /^debug\s+(.+)/i,
        /^repair\s+(.+)/i,
      ],
      extract: (_match, raw) => {
        const filepath = _match[1].trim();
        // Check for an inline error message after "error:" or "error is"
        const errMatch = raw.match(/(?:error[:\s]+is?\s*)(.*)/i);
        return { filepath, error: errMatch ? errMatch[1].trim() : '' };
      },
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'generate':
        return this.generate(command.args.description);
      case 'write-code':
        return this.writeCode(command.args.description, command.args.filepath);
      case 'explain':
        return this.explain(command.args.filepath);
      case 'fix':
        return this.fix(command.args.filepath, command.args.error);
      default:
        return { success: false, message: `Unknown dev-agent action: ${command.action}` };
    }
  }

  // ── Generate: full autonomous project ──

  private async generate(description: string): Promise<CommandResult> {
    ensureProjectsDir();

    // Step 1: Plan
    process.stdout.write('\n  [dev-agent] Planning project structure...\n');
    let planJson = '';
    const planRaw = await llmStreamChat(
      [{ role: 'user', content: `Create a project: ${description}` }],
      PLAN_SYSTEM_PROMPT,
      (token) => { planJson += token; },
    );

    let plan: ProjectPlan;
    try {
      plan = parsePlan(planRaw || planJson);
    } catch {
      return { success: false, message: 'Failed to parse project plan from LLM. Try rephrasing your request.' };
    }

    const projectDir = join(PROJECTS_DIR, plan.name);

    // Step 2: Write files
    process.stdout.write(`  [dev-agent] Creating ${plan.files.length} files in ${projectDir}\n`);
    try {
      mkdirSync(projectDir, { recursive: true });
      writeProjectFiles(projectDir, plan.files);
    } catch (err: unknown) {
      return { success: false, message: `Failed to write project files: ${(err as Error).message}` };
    }

    // Step 3: Install dependencies
    if (plan.install) {
      process.stdout.write(`  [dev-agent] Installing dependencies: ${plan.install}\n`);
      const installResult = runCommand(plan.install, projectDir, 120_000);
      if (!installResult.ok) {
        process.stdout.write(`  [dev-agent] Install warning: ${installResult.output.slice(0, 200)}\n`);
      }
    }

    // Step 4: Attempt to run (with self-healing, max 3 attempts)
    let runSuccess = false;
    let lastError = '';
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      process.stdout.write(`  [dev-agent] Run attempt ${attempt}/${MAX_ATTEMPTS}: ${plan.run}\n`);
      const runResult = runCommand(plan.run, projectDir, 15_000);

      if (runResult.ok) {
        runSuccess = true;
        break;
      }

      lastError = runResult.output;
      process.stdout.write(`  [dev-agent] Error on attempt ${attempt}: ${lastError.slice(0, 200)}\n`);

      if (attempt < MAX_ATTEMPTS) {
        // Ask LLM to fix
        process.stdout.write('  [dev-agent] Asking LLM for a fix...\n');
        const currentFiles = plan.files.map(f => {
          const fullPath = join(projectDir, f.path);
          try {
            return { path: f.path, content: readFileSync(fullPath, 'utf-8') };
          } catch {
            return { path: f.path, content: f.content };
          }
        });

        let fixJson = '';
        const fixRaw = await llmStreamChat(
          [{
            role: 'user',
            content: `The project failed to run with this error:\n${lastError}\n\nHere are the current files:\n${JSON.stringify(currentFiles, null, 2)}\n\nFix the project. Respond with the FULL updated JSON plan in the same format (name, tech, files, install, run).`,
          }],
          PLAN_SYSTEM_PROMPT,
          (token) => { fixJson += token; },
        );

        try {
          const fixPlan = parsePlan(fixRaw || fixJson);
          writeProjectFiles(projectDir, fixPlan.files);
          plan.run = fixPlan.run;
          plan.files = fixPlan.files;

          // Re-install if install command changed
          if (fixPlan.install && fixPlan.install !== plan.install) {
            runCommand(fixPlan.install, projectDir, 120_000);
            plan.install = fixPlan.install;
          }
        } catch {
          process.stdout.write('  [dev-agent] Could not parse fix from LLM, retrying...\n');
        }
      }
    }

    // Step 5: Open in VS Code
    try {
      execSync(`code "${projectDir}"`, { stdio: 'ignore' });
    } catch {
      // VS Code CLI not available — not critical
    }

    const status = runSuccess
      ? `Project "${plan.name}" built and running successfully.`
      : `Project "${plan.name}" created but encountered run errors:\n${lastError.slice(0, 300)}`;

    return {
      success: true,
      message: `${status}\n  Location: ${projectDir}`,
      voiceMessage: runSuccess
        ? `Project ${plan.name} is ready and running. I've opened it in VS Code.`
        : `Project ${plan.name} has been created but has some errors. I've opened it in VS Code for you to review.`,
      data: { projectDir, plan: { name: plan.name, tech: plan.tech, files: plan.files.map(f => f.path) } },
    };
  }

  // ── Write Code: single file ──

  private async writeCode(description: string, filepath?: string): Promise<CommandResult> {
    ensureProjectsDir();

    process.stdout.write('\n  [dev-agent] Generating code...\n');
    let code = '';
    await llmStreamChat(
      [{ role: 'user', content: description }],
      CODE_SYSTEM_PROMPT,
      (token) => {
        code += token;
        process.stdout.write(token);
      },
    );
    process.stdout.write('\n');

    // Strip markdown fences if present
    let cleaned = code.trim();
    if (cleaned.startsWith('```')) {
      const firstNewline = cleaned.indexOf('\n');
      cleaned = cleaned.slice(firstNewline + 1);
      if (cleaned.endsWith('```')) {
        cleaned = cleaned.slice(0, -3).trimEnd();
      }
    }

    // Determine output path
    let outputPath: string;
    if (filepath && filepath.length > 0) {
      outputPath = filepath.startsWith('~')
        ? filepath.replace('~', homedir())
        : filepath.startsWith('/')
          ? filepath
          : join(PROJECTS_DIR, filepath);
    } else {
      // Infer filename from description
      const slug = description
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40);
      const ext = cleaned.includes('def ') || cleaned.includes('import ') ? '.py' : '.js';
      outputPath = join(PROJECTS_DIR, `${slug}${ext}`);
    }

    const dir = join(outputPath, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(outputPath, cleaned, 'utf-8');

    return {
      success: true,
      message: `Code written to ${outputPath}`,
      voiceMessage: `Done. I've saved the code to ${outputPath.split('/').pop()}.`,
      streamed: true,
    };
  }

  // ── Explain: explain a code file ──

  private async explain(filepath: string): Promise<CommandResult> {
    const resolved = filepath.startsWith('~')
      ? filepath.replace('~', homedir())
      : filepath;

    if (!existsSync(resolved)) {
      return { success: false, message: `File not found: ${resolved}` };
    }

    const content = readFileSync(resolved, 'utf-8');
    const filename = resolved.split('/').pop() || filepath;

    process.stdout.write(`\n  [dev-agent] Explaining ${filename}...\n\n`);
    await llmStreamChat(
      [{ role: 'user', content: `Explain this code from ${filename}:\n\n${content}` }],
      EXPLAIN_SYSTEM_PROMPT,
      (token) => { process.stdout.write(token); },
    );
    process.stdout.write('\n');

    return {
      success: true,
      message: `Explanation of ${filename} streamed above.`,
      voiceMessage: `I've explained the code in ${filename}.`,
      streamed: true,
    };
  }

  // ── Fix: fix errors in a code file ──

  private async fix(filepath: string, error?: string): Promise<CommandResult> {
    const resolved = filepath.startsWith('~')
      ? filepath.replace('~', homedir())
      : filepath;

    if (!existsSync(resolved)) {
      return { success: false, message: `File not found: ${resolved}` };
    }

    const content = readFileSync(resolved, 'utf-8');
    const filename = resolved.split('/').pop() || filepath;

    // If no error message provided, try running the file to get one
    let errorMsg = error || '';
    if (!errorMsg) {
      const ext = resolved.split('.').pop();
      let runCmd = '';
      if (ext === 'js' || ext === 'mjs') runCmd = `node "${resolved}"`;
      else if (ext === 'ts') runCmd = `npx tsx "${resolved}"`;
      else if (ext === 'py') runCmd = `python3 "${resolved}"`;

      if (runCmd) {
        const result = runCommand(runCmd, join(resolved, '..'), 10_000);
        if (!result.ok) {
          errorMsg = result.output;
        } else {
          return { success: true, message: `${filename} runs without errors. No fix needed.` };
        }
      }
    }

    process.stdout.write(`\n  [dev-agent] Fixing ${filename}...\n`);
    let fixedCode = '';
    await llmStreamChat(
      [{
        role: 'user',
        content: `Fix this code:\n\n${content}\n\nError:\n${errorMsg || 'Unknown error — review the code for bugs and fix them.'}`,
      }],
      FIX_SYSTEM_PROMPT,
      (token) => { fixedCode += token; },
    );

    // Strip markdown fences
    let cleaned = fixedCode.trim();
    if (cleaned.startsWith('```')) {
      const firstNewline = cleaned.indexOf('\n');
      cleaned = cleaned.slice(firstNewline + 1);
      if (cleaned.endsWith('```')) {
        cleaned = cleaned.slice(0, -3).trimEnd();
      }
    }

    writeFileSync(resolved, cleaned, 'utf-8');

    return {
      success: true,
      message: `Fixed ${filename} and saved changes.`,
      voiceMessage: `I've fixed the code in ${filename}.`,
    };
  }

  getHelp(): string {
    return [
      '  Dev Agent — autonomous project generator',
      '    build me <desc>      Generate a full project from a description',
      '    create <desc>        Same as build',
      '    write code for <x>   Generate and save a single code file',
      '    explain <filepath>   Explain a code file',
      '    fix <filepath>       Auto-fix errors in a code file',
    ].join('\n');
  }
}
