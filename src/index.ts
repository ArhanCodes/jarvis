import * as readline from 'readline';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { registry } from './core/registry.js';
import { parse } from './core/parser.js';
import { execute } from './core/executor.js';
import { fmt } from './utils/formatter.js';
import { AppLauncherModule } from './modules/app-launcher.js';
import { ScriptRunnerModule } from './modules/script-runner.js';
import { SystemMonitorModule } from './modules/system-monitor.js';
import { FileOperationsModule } from './modules/file-operations.js';
import { SystemControlModule } from './modules/system-control.js';
import { TimerModule } from './modules/timer.js';
import { voiceInput } from './voice/voice-input.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getConfigPath(filename: string): string {
  const paths = [
    join(__dirname, '..', 'config', filename),
    join(__dirname, '..', '..', 'config', filename),
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return paths[0];
}

function getAliasPath(): string {
  return getConfigPath('aliases.json');
}

function getStartupPath(): string {
  return getConfigPath('startup.json');
}

interface StartupConfig {
  commands: string[];
  greeting: boolean;
}

function printBanner(): void {
  console.log(fmt.banner(`
       ██╗ █████╗ ██████╗ ██╗   ██╗██╗███████╗
       ██║██╔══██╗██╔══██╗██║   ██║██║██╔════╝
       ██║███████║██████╔╝██║   ██║██║███████╗
  ██   ██║██╔══██║██╔══██╗╚██╗ ██╔╝██║╚════██║
  ╚█████╔╝██║  ██║██║  ██║ ╚████╔╝ ██║███████║
   ╚════╝ ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝`));
  console.log(fmt.info('Just A Rather Very Intelligent System — v1.0.0'));
  console.log(fmt.info('Type "help" for available commands, "exit" to quit.\n'));
}

function printHelp(): void {
  console.log(fmt.heading('Available Commands'));
  for (const mod of registry.getAll()) {
    console.log(mod.getHelp());
    console.log('');
  }
  console.log('  Meta Commands');
  console.log('    help               Show this help message');
  console.log('    help <module>      Show module-specific help');
  console.log('    alias <n> = <cmd>  Create a command alias');
  console.log('    aliases            List all aliases');
  console.log('    voice              Enter voice command mode (uses macOS Speech)');
  console.log('    listen             Same as voice');
  console.log('    startup add <cmd>  Add a command to run on startup');
  console.log('    startup list       List startup commands');
  console.log('    startup clear      Clear all startup commands');
  console.log('    exit / quit        Exit JARVIS');
  console.log('');
}

function handleAlias(input: string): boolean {
  // "alias name = command"
  const aliasMatch = input.match(/^alias\s+(\S+)\s*=\s*(.+)/i);
  if (aliasMatch) {
    const [, name, command] = aliasMatch;
    const aliasPath = getAliasPath();
    let aliases: Record<string, string> = {};
    try { aliases = JSON.parse(readFileSync(aliasPath, 'utf-8')); } catch { /* empty */ }
    aliases[name.toLowerCase()] = command.trim();
    writeFileSync(aliasPath, JSON.stringify(aliases, null, 2) + '\n');
    console.log(fmt.success(`Alias created: "${name}" → "${command.trim()}"`));
    return true;
  }

  // "aliases"
  if (/^aliases$/i.test(input)) {
    const aliasPath = getAliasPath();
    try {
      const aliases = JSON.parse(readFileSync(aliasPath, 'utf-8')) as Record<string, string>;
      const entries = Object.entries(aliases);
      if (entries.length === 0) {
        console.log(fmt.info('No aliases defined.'));
      } else {
        console.log(fmt.heading('Aliases'));
        for (const [key, val] of entries) {
          console.log(fmt.label(key, val));
        }
      }
    } catch {
      console.log(fmt.info('No aliases defined.'));
    }
    return true;
  }

  return false;
}

function handleStartup(input: string): boolean {
  const addMatch = input.match(/^startup\s+add\s+(.+)/i);
  if (addMatch) {
    const cmd = addMatch[1].trim();
    const startupPath = getStartupPath();
    let config: StartupConfig = { commands: [], greeting: true };
    try { config = JSON.parse(readFileSync(startupPath, 'utf-8')); } catch { /* empty */ }
    config.commands.push(cmd);
    writeFileSync(startupPath, JSON.stringify(config, null, 2) + '\n');
    console.log(fmt.success(`Startup command added: "${cmd}"`));
    return true;
  }

  if (/^startup\s+list$/i.test(input)) {
    const startupPath = getStartupPath();
    try {
      const config = JSON.parse(readFileSync(startupPath, 'utf-8')) as StartupConfig;
      if (config.commands.length === 0) {
        console.log(fmt.info('No startup commands configured.'));
      } else {
        console.log(fmt.heading('Startup Commands'));
        config.commands.forEach((cmd, i) => {
          console.log(`    ${i + 1}. ${cmd}`);
        });
      }
    } catch {
      console.log(fmt.info('No startup commands configured.'));
    }
    return true;
  }

  if (/^startup\s+clear$/i.test(input)) {
    const startupPath = getStartupPath();
    const config: StartupConfig = { commands: [], greeting: true };
    writeFileSync(startupPath, JSON.stringify(config, null, 2) + '\n');
    console.log(fmt.success('Startup commands cleared.'));
    return true;
  }

  const removeMatch = input.match(/^startup\s+remove\s+(\d+)/i);
  if (removeMatch) {
    const idx = parseInt(removeMatch[1], 10) - 1;
    const startupPath = getStartupPath();
    let config: StartupConfig = { commands: [], greeting: true };
    try { config = JSON.parse(readFileSync(startupPath, 'utf-8')); } catch { /* empty */ }
    if (idx >= 0 && idx < config.commands.length) {
      const removed = config.commands.splice(idx, 1)[0];
      writeFileSync(startupPath, JSON.stringify(config, null, 2) + '\n');
      console.log(fmt.success(`Removed startup command: "${removed}"`));
    } else {
      console.log(fmt.error(`Invalid index: ${idx + 1}`));
    }
    return true;
  }

  return false;
}

async function runStartupCommands(): Promise<void> {
  const startupPath = getStartupPath();
  try {
    const config = JSON.parse(readFileSync(startupPath, 'utf-8')) as StartupConfig;
    if (config.commands.length > 0) {
      console.log(fmt.dim('  Running startup commands...'));
      for (const cmd of config.commands) {
        console.log(fmt.dim(`  → ${cmd}`));
        const parsed = parse(cmd);
        if (parsed) {
          const result = await execute(parsed);
          if (result.success) {
            console.log(fmt.success(result.message));
          } else {
            console.log(fmt.error(result.message));
          }
        }
      }
      console.log('');
    }
  } catch { /* no startup config */ }
}

export function boot(): void {
  // Register modules
  registry.register(new AppLauncherModule());
  registry.register(new ScriptRunnerModule());
  registry.register(new SystemMonitorModule());
  registry.register(new FileOperationsModule());
  registry.register(new SystemControlModule());
  registry.register(new TimerModule());

  printBanner();

  // Run startup commands
  runStartupCommands();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: fmt.prompt(),
  });

  let processing = false;
  let closing = false;

  const lines: string[] = [];

  async function processLine(input: string): Promise<void> {
    if (!input) return;

    // Exit
    if (/^(exit|quit|bye|q)$/i.test(input)) {
      console.log(fmt.info('Goodbye, sir.\n'));
      process.exit(0);
    }

    // Help
    if (/^help$/i.test(input)) {
      printHelp();
      return;
    }

    // Module-specific help
    const helpMatch = input.match(/^help\s+(.+)/i);
    if (helpMatch) {
      const modName = helpMatch[1].toLowerCase();
      const mod = registry.getAll().find(m =>
        m.name === modName || m.name.includes(modName) || m.description.toLowerCase().includes(modName)
      );
      if (mod) {
        console.log(mod.getHelp());
      } else {
        console.log(fmt.warn(`Unknown module: "${helpMatch[1]}"`));
      }
      return;
    }

    // Alias commands
    if (handleAlias(input)) return;

    // Startup commands
    if (handleStartup(input)) return;

    // Voice mode
    if (/^(?:voice|listen|voice\s+mode|start\s+listening)$/i.test(input)) {
      const available = await voiceInput.isAvailable();
      if (!available) {
        console.log(fmt.error('Voice input not available. Requires macOS with Xcode Command Line Tools.'));
        return;
      }
      await voiceInput.startContinuous(async (text) => {
        const parsed = parse(text);
        if (parsed) {
          const result = await execute(parsed);
          if (result.success) {
            console.log(fmt.success(result.message));
          } else {
            console.log(fmt.error(result.message));
          }
        } else {
          console.log(fmt.warn(`Didn't understand: "${text}"`));
        }
      });
      return;
    }

    // Parse and execute
    const parsed = parse(input);
    if (!parsed) {
      console.log(fmt.warn(`I didn't understand "${input}". Type "help" for available commands.`));
      return;
    }

    const result = await execute(parsed);
    if (result.success) {
      console.log(fmt.success(result.message));
    } else {
      console.log(fmt.error(result.message));
    }
  }

  async function drain(): Promise<void> {
    if (processing) return;
    processing = true;
    while (lines.length > 0) {
      const line = lines.shift()!;
      await processLine(line);
      if (!closing) rl.prompt();
    }
    processing = false;
    if (closing) {
      console.log(fmt.info('\nGoodbye, sir.\n'));
      process.exit(0);
    }
  }

  rl.prompt();

  rl.on('line', (line) => {
    lines.push(line.trim());
    drain();
  });

  rl.on('close', () => {
    closing = true;
    if (!processing) {
      console.log(fmt.info('\nGoodbye, sir.\n'));
      process.exit(0);
    }
  });
}
