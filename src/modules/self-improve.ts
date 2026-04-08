import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { llmStreamChat } from '../utils/llm.js';
import { registry } from '../core/registry.js';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = join(__dirname, 'generated');
const CONFIG_PATH = join(__dirname, '..', '..', 'config', 'generated-modules.json');

const MAX_COMPILE_ATTEMPTS = 3;

const TEMPLATE_MODULE = `import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../../core/types.js';

export default class ExampleModule implements JarvisModule {
  name = 'example' as const;
  description = 'A brief description of what this module does';

  patterns: PatternDefinition[] = [
    {
      intent: 'do-something',
      patterns: [
        /^do something (.+)/i,
        /^example (.+)/i,
      ],
      extract: (match) => ({ query: match[1].trim() }),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'do-something':
        return this.doSomething(command.args.query);
      default:
        return { success: false, message: \`Unknown action: \${command.action}\` };
    }
  }

  private async doSomething(query: string): Promise<CommandResult> {
    return {
      success: true,
      message: \`Processed: \${query}\`,
      voiceMessage: \`Done processing \${query}.\`,
    };
  }

  getHelp(): string {
    return '  example <query>   Do something with the query';
  }
}
`;

const JARVIS_MODULE_INTERFACE = `export type ModuleName = string; // dynamically registered modules use any string name

export interface ParsedCommand {
  module: ModuleName;
  action: string;
  args: Record<string, string>;
  raw: string;
  confidence: number;
}

export interface CommandResult {
  success: boolean;
  message: string;
  voiceMessage?: string;
  data?: unknown;
  streamed?: boolean;
}

export interface PatternDefinition {
  intent: string;
  patterns: RegExp[];
  extract: (match: RegExpMatchArray, raw: string) => Record<string, string>;
}

export interface JarvisModule {
  name: ModuleName;
  description: string;
  patterns: PatternDefinition[];
  execute(command: ParsedCommand): Promise<CommandResult>;
  getHelp(): string;
}`;

const GENERATE_SYSTEM_PROMPT = `You are JARVIS's self-improvement engine. You generate complete, working TypeScript modules that implement the JarvisModule interface.

Here is the JarvisModule interface:
${JARVIS_MODULE_INTERFACE}

Here is an example module for reference:
${TEMPLATE_MODULE}

Rules:
1. The class MUST be exported as default: \`export default class XxxModule implements JarvisModule\`
2. The module name should be a kebab-case string (e.g. 'package-tracker')
3. Import types from '../../core/types.js' (the generated file is in src/modules/generated/)
4. Include at least 2-3 regex patterns for natural language matching
5. The extract function must return a Record<string, string>
6. Handle errors gracefully — never throw, always return { success: false, message: ... }
7. You may use Node.js built-ins: child_process (execSync), fs, path, os, https, http
8. You may use fetch() for HTTP requests
9. Do NOT import any third-party npm packages
10. Write COMPLETE, working TypeScript code — no placeholders or TODOs
11. Use 'as const' for the module name to satisfy the type system
12. Respond with ONLY the TypeScript code — no markdown fences, no explanations`;

const FIX_SYSTEM_PROMPT = `You are fixing a TypeScript module that failed to compile. The user will provide:
1. The current code
2. The TypeScript compiler errors

Fix ALL errors and respond with ONLY the complete, corrected TypeScript code — no markdown fences, no explanations.`;

interface GeneratedModuleEntry {
  name: string;
  path: string;
  description: string;
  createdAt: string;
}

function loadGeneratedModules(): GeneratedModuleEntry[] {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as GeneratedModuleEntry[];
    }
  } catch {
    // ignore corrupt config
  }
  return [];
}

function saveGeneratedModules(modules: GeneratedModuleEntry[]): void {
  const configDir = dirname(CONFIG_PATH);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(modules, null, 2), 'utf-8');
}

function stripMarkdownFences(code: string): string {
  let cleaned = code.trim();
  if (cleaned.startsWith('```')) {
    const firstNewline = cleaned.indexOf('\n');
    cleaned = cleaned.slice(firstNewline + 1);
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3).trimEnd();
    }
  }
  return cleaned;
}

function tryCompile(filePath: string): { ok: boolean; errors: string } {
  try {
    execSync(`npx tsc --noEmit --esModuleInterop --module nodenext --moduleResolution nodenext --target es2022 "${filePath}"`, {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, errors: '' };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, errors: (e.stdout || '') + (e.stderr || '') };
  }
}

export class SelfImproveModule implements JarvisModule {
  name = 'self-improve' as const;
  description = 'JARVIS self-improvement engine — generate new modules from natural language descriptions';

  patterns: PatternDefinition[] = [
    {
      intent: 'create-module',
      patterns: [
        /^create\s+(?:a\s+)?module\s+(?:to\s+|for\s+|that\s+)?(.+)/i,
        /^learn\s+to\s+(.+)/i,
        /^add\s+(?:the\s+)?ability\s+to\s+(.+)/i,
        /^upgrade\s+yourself\s+to\s+(.+)/i,
        /^teach\s+yourself\s+(?:to\s+)?(.+)/i,
        /^(?:add|create)\s+(?:a\s+)?new\s+(?:skill|capability|ability)\s+(?:to\s+|for\s+)?(.+)/i,
      ],
      extract: (match) => ({ description: match[1].trim() }),
    },
    {
      intent: 'list-modules',
      patterns: [
        /^list\s+(?:all\s+)?generated\s+modules$/i,
        /^show\s+(?:all\s+)?(?:generated|learned|custom)\s+modules$/i,
        /^what\s+(?:have\s+you|did\s+you)\s+learn/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'remove-module',
      patterns: [
        /^remove\s+(?:the\s+)?(?:generated\s+)?module\s+(.+)/i,
        /^delete\s+(?:the\s+)?(?:generated\s+)?module\s+(.+)/i,
        /^unlearn\s+(.+)/i,
      ],
      extract: (match) => ({ name: match[1].trim() }),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'create-module':
        return this.createModule(command.args.description);
      case 'list-modules':
        return this.listModules();
      case 'remove-module':
        return this.removeModule(command.args.name);
      default:
        return { success: false, message: `Unknown self-improve action: ${command.action}` };
    }
  }

  private async createModule(description: string): Promise<CommandResult> {
    mkdirSync(GENERATED_DIR, { recursive: true });

    // Step 1: Generate module code via LLM
    process.stdout.write(`\n  [self-improve] Generating module for: "${description}"...\n`);
    let generatedCode = '';
    await llmStreamChat(
      [{ role: 'user', content: `Create a JARVIS module that can: ${description}` }],
      GENERATE_SYSTEM_PROMPT,
      (token) => { generatedCode += token; },
    );

    let code = stripMarkdownFences(generatedCode);

    // Extract module name from the code
    const nameMatch = code.match(/name\s*=\s*['"]([^'"]+)['"]/);
    const moduleName = nameMatch ? nameMatch[1] : description.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
    const fileName = `${moduleName}.ts`;
    const filePath = join(GENERATED_DIR, fileName);

    // Step 2: Write and try to compile, with fix loop
    for (let attempt = 1; attempt <= MAX_COMPILE_ATTEMPTS; attempt++) {
      writeFileSync(filePath, code, 'utf-8');
      process.stdout.write(`  [self-improve] Compile attempt ${attempt}/${MAX_COMPILE_ATTEMPTS}...\n`);

      const compileResult = tryCompile(filePath);
      if (compileResult.ok) {
        process.stdout.write('  [self-improve] Compilation successful!\n');
        break;
      }

      process.stdout.write(`  [self-improve] Compile errors: ${compileResult.errors.slice(0, 200)}\n`);

      if (attempt >= MAX_COMPILE_ATTEMPTS) {
        // Keep the file but warn
        process.stdout.write('  [self-improve] Max compile attempts reached. Saving anyway for manual review.\n');
        break;
      }

      // Ask LLM to fix
      let fixedCode = '';
      await llmStreamChat(
        [{
          role: 'user',
          content: `Fix these TypeScript compilation errors:\n\nErrors:\n${compileResult.errors.slice(0, 2000)}\n\nCurrent code:\n${code}`,
        }],
        FIX_SYSTEM_PROMPT,
        (token) => { fixedCode += token; },
      );

      code = stripMarkdownFences(fixedCode);
    }

    // Step 3: Dynamic import and registration
    try {
      const mod = await import(filePath);
      const ModuleClass = mod.default;
      if (!ModuleClass) {
        return { success: false, message: `Generated module at ${filePath} does not have a default export.` };
      }
      const instance = new ModuleClass() as JarvisModule;
      registry.register(instance);
      process.stdout.write(`  [self-improve] Module "${instance.name}" registered successfully!\n`);

      // Step 4: Save to config for reload on boot
      const modules = loadGeneratedModules();
      const existing = modules.findIndex(m => m.name === moduleName);
      const entry: GeneratedModuleEntry = {
        name: moduleName,
        path: filePath,
        description,
        createdAt: new Date().toISOString(),
      };
      if (existing >= 0) {
        modules[existing] = entry;
      } else {
        modules.push(entry);
      }
      saveGeneratedModules(modules);

      return {
        success: true,
        message: `Module "${moduleName}" created and activated.\n  File: ${filePath}\n  Description: ${instance.description}\n  Help:\n${instance.getHelp()}`,
        voiceMessage: `I've learned a new ability: ${moduleName}. It's ready to use now.`,
        data: { name: moduleName, path: filePath },
      };
    } catch (err: unknown) {
      return {
        success: false,
        message: `Module generated at ${filePath} but failed to load: ${(err as Error).message}\nYou may need to fix it manually.`,
      };
    }
  }

  private listModules(): CommandResult {
    const modules = loadGeneratedModules();
    if (modules.length === 0) {
      return {
        success: true,
        message: 'No generated modules yet. Use "learn to <ability>" to create one.',
        voiceMessage: 'No generated modules yet.',
      };
    }

    const list = modules.map((m, i) =>
      `  ${i + 1}. ${m.name} — ${m.description} (created ${m.createdAt.split('T')[0]})`
    ).join('\n');

    return {
      success: true,
      message: `Generated modules:\n${list}`,
      voiceMessage: `You have ${modules.length} generated module${modules.length > 1 ? 's' : ''}.`,
      data: modules,
    };
  }

  private removeModule(name: string): CommandResult {
    const modules = loadGeneratedModules();
    const idx = modules.findIndex(m => m.name === name || m.name === name.replace(/\s+/g, '-'));

    if (idx === -1) {
      return { success: false, message: `No generated module found with name "${name}".` };
    }

    const entry = modules[idx];

    // Delete the file
    try {
      if (existsSync(entry.path)) {
        unlinkSync(entry.path);
      }
    } catch (err: unknown) {
      return { success: false, message: `Failed to delete module file: ${(err as Error).message}` };
    }

    // Remove from config
    modules.splice(idx, 1);
    saveGeneratedModules(modules);

    return {
      success: true,
      message: `Module "${entry.name}" removed and deleted.`,
      voiceMessage: `I've removed the ${entry.name} module.`,
    };
  }

  getHelp(): string {
    return [
      '  Self-Improve -- JARVIS generates its own new modules',
      '    create module to <desc>    Generate a new module from description',
      '    learn to <ability>         Same as create module',
      '    teach yourself <ability>   Same as create module',
      '    list generated modules     Show all generated modules',
      '    remove module <name>       Delete a generated module',
    ].join('\n');
  }
}
