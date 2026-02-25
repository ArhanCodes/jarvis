import * as readline from 'readline';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { registry } from './core/registry.js';
import { parse, splitChainedCommands } from './core/parser.js';
import { execute } from './core/executor.js';
import { fmt } from './utils/formatter.js';
import { recordCommand, getHistory, searchHistory, getLastCommand, flushHistory, clearHistory } from './core/history.js';
import { setLast, getSessionInfo, setVar, getAllVars } from './core/context.js';
import { AppLauncherModule } from './modules/app-launcher.js';
import { ScriptRunnerModule } from './modules/script-runner.js';
import { SystemMonitorModule } from './modules/system-monitor.js';
import { FileOperationsModule } from './modules/file-operations.js';
import { SystemControlModule } from './modules/system-control.js';
import { TimerModule } from './modules/timer.js';
import { ProcessManagerModule } from './modules/process-manager.js';
import { ClipboardModule } from './modules/clipboard.js';
import { WindowManagerModule } from './modules/window-manager.js';
import { MediaControlModule } from './modules/media-control.js';
import { WorkflowModule } from './modules/workflow.js';
import { PersonalityModule, getStartupGreeting } from './modules/personality.js';
import { AIChatModule } from './modules/ai-chat.js';
import { SmartAssistModule, tryNaturalLanguageMapping, getSuggestions } from './modules/smart-assist.js';
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

function getAliasPath(): string { return getConfigPath('aliases.json'); }
function getStartupPath(): string { return getConfigPath('startup.json'); }

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
  console.log(fmt.info('Just A Rather Very Intelligent System — v2.1.0'));
  console.log(fmt.dim(`  ${registry.getAll().length} modules loaded | ${new Date().toLocaleDateString()}`));
  console.log(fmt.info('Type "help" for commands, "exit" to quit.\n'));
}

function printHelp(): void {
  console.log(fmt.heading('Available Commands'));
  for (const mod of registry.getAll()) {
    console.log(mod.getHelp());
    console.log('');
  }
  console.log('  Meta Commands');
  console.log('    help                Show this help message');
  console.log('    help <module>       Module-specific help');
  console.log('    alias <n> = <cmd>   Create a command alias');
  console.log('    aliases             List all aliases');
  console.log('    voice / listen      Enter voice command mode');
  console.log('    history             Show command history');
  console.log('    history search <q>  Search command history');
  console.log('    !!                  Repeat last command');
  console.log('    set <var> = <val>   Set a variable');
  console.log('    vars                Show all variables');
  console.log('    uptime              Session info');
  console.log('    startup add <cmd>   Auto-run command on boot');
  console.log('    startup list        List startup commands');
  console.log('    startup clear       Clear startup commands');
  console.log('    cmd1 && cmd2        Chain commands');
  console.log('    exit / quit         Exit JARVIS');
  console.log('');
}

function handleAlias(input: string): boolean {
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

  // Delete alias
  const delMatch = input.match(/^(?:delete|remove)\s+alias\s+(\S+)/i);
  if (delMatch) {
    const aliasPath = getAliasPath();
    let aliases: Record<string, string> = {};
    try { aliases = JSON.parse(readFileSync(aliasPath, 'utf-8')); } catch { /* empty */ }
    const key = delMatch[1].toLowerCase();
    if (key in aliases) {
      delete aliases[key];
      writeFileSync(aliasPath, JSON.stringify(aliases, null, 2) + '\n');
      console.log(fmt.success(`Alias "${key}" removed`));
    } else {
      console.log(fmt.warn(`Alias "${key}" not found`));
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
        config.commands.forEach((cmd, i) => { console.log(`    ${i + 1}. ${cmd}`); });
      }
    } catch {
      console.log(fmt.info('No startup commands configured.'));
    }
    return true;
  }

  if (/^startup\s+clear$/i.test(input)) {
    const startupPath = getStartupPath();
    writeFileSync(startupPath, JSON.stringify({ commands: [], greeting: true }, null, 2) + '\n');
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

function handleMeta(input: string): boolean {
  // History
  if (/^history$/i.test(input)) {
    const entries = getHistory(20);
    if (entries.length === 0) {
      console.log(fmt.info('No command history yet.'));
    } else {
      console.log(fmt.heading('Command History (last 20)'));
      entries.forEach((e, i) => {
        const ts = new Date(e.timestamp).toLocaleTimeString();
        const icon = e.success ? '✓' : '✗';
        console.log(`    ${icon} [${ts}] ${e.command}`);
      });
    }
    return true;
  }

  const histSearchMatch = input.match(/^history\s+search\s+(.+)/i);
  if (histSearchMatch) {
    const results = searchHistory(histSearchMatch[1]);
    if (results.length === 0) {
      console.log(fmt.info(`No history matching "${histSearchMatch[1]}"`));
    } else {
      console.log(fmt.heading('Search Results'));
      results.forEach(e => {
        const ts = new Date(e.timestamp).toLocaleTimeString();
        console.log(`    [${ts}] ${e.command}`);
      });
    }
    return true;
  }

  if (/^clear\s+history$/i.test(input)) {
    clearHistory();
    console.log(fmt.success('Command history cleared.'));
    return true;
  }

  // Variables
  const setMatch = input.match(/^set\s+(\w+)\s*=\s*(.+)/i);
  if (setMatch) {
    setVar(setMatch[1], setMatch[2].trim());
    console.log(fmt.success(`$${setMatch[1]} = "${setMatch[2].trim()}"`));
    return true;
  }

  if (/^vars$/i.test(input)) {
    const vars = getAllVars();
    if (vars.size === 0) {
      console.log(fmt.info('No variables set. Use: set <name> = <value>'));
    } else {
      console.log(fmt.heading('Variables'));
      for (const [key, val] of vars) {
        console.log(fmt.label(`$${key}`, val));
      }
    }
    return true;
  }

  // Uptime
  if (/^uptime$/i.test(input)) {
    const info = getSessionInfo();
    const mins = Math.floor(info.uptime / 60);
    const secs = info.uptime % 60;
    console.log(fmt.label('Session', `${mins}m ${secs}s`));
    console.log(fmt.label('Commands', String(info.commandCount)));
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
          if (result.success) console.log(fmt.success(result.message));
          else console.log(fmt.error(result.message));
        }
      }
      console.log('');
    }
  } catch { /* no startup config */ }
}

export function boot(): void {
  // Register all modules
  registry.register(new AppLauncherModule());
  registry.register(new ScriptRunnerModule());
  registry.register(new SystemMonitorModule());
  registry.register(new FileOperationsModule());
  registry.register(new SystemControlModule());
  registry.register(new TimerModule());
  registry.register(new ProcessManagerModule());
  registry.register(new ClipboardModule());
  registry.register(new WindowManagerModule());
  registry.register(new MediaControlModule());
  registry.register(new WorkflowModule());
  registry.register(new PersonalityModule());
  registry.register(new AIChatModule());
  registry.register(new SmartAssistModule());

  printBanner();
  console.log(fmt.info(getStartupGreeting()));
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
      flushHistory();
      console.log(fmt.info('Goodbye, sir.\n'));
      process.exit(0);
    }

    // Help
    if (/^help$/i.test(input)) { printHelp(); return; }

    // Module-specific help
    const helpMatch = input.match(/^help\s+(.+)/i);
    if (helpMatch) {
      const modName = helpMatch[1].toLowerCase();
      const mod = registry.getAll().find(m =>
        m.name === modName || m.name.includes(modName) || m.description.toLowerCase().includes(modName)
      );
      if (mod) console.log(mod.getHelp());
      else console.log(fmt.warn(`Unknown module: "${helpMatch[1]}"`));
      return;
    }

    // Repeat last command
    if (input === '!!') {
      const last = getLastCommand();
      if (last) {
        console.log(fmt.dim(`  → ${last}`));
        await processLine(last);
      } else {
        console.log(fmt.warn('No previous command.'));
      }
      return;
    }

    // Meta commands
    if (handleAlias(input)) return;
    if (handleStartup(input)) return;
    if (handleMeta(input)) return;

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
          setLast(parsed, result);
          recordCommand(text, result);
          if (result.success) console.log(fmt.success(result.message));
          else console.log(fmt.error(result.message));
        } else {
          console.log(fmt.warn(`Didn't understand: "${text}"`));
        }
      });
      return;
    }

    // ── Command chaining: split on && and ; ──
    const commands = splitChainedCommands(input);
    if (commands.length > 1) {
      for (const cmd of commands) {
        await processLine(cmd);
      }
      return;
    }

    // Parse and execute
    let parsed = parse(input);

    // NLU fallback: try natural language mapping if regex/keyword parsing failed
    if (!parsed) {
      parsed = tryNaturalLanguageMapping(input);
    }

    if (!parsed) {
      const suggestions = getSuggestions(input);
      if (suggestions.length > 0) {
        console.log(fmt.warn(`I didn't understand "${input}". Did you mean:`));
        for (const s of suggestions) {
          console.log(fmt.suggestion(s));
        }
        console.log(fmt.dim('  Type "help" for all commands.'));
      } else {
        console.log(fmt.warn(`I didn't understand "${input}". Type "help" for available commands.`));
      }
      return;
    }

    const result = await execute(parsed);
    setLast(parsed, result);
    recordCommand(input, result);

    if (result.success) {
      if (!result.streamed) console.log(fmt.success(result.message));
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
      flushHistory();
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
      flushHistory();
      console.log(fmt.info('\nGoodbye, sir.\n'));
      process.exit(0);
    }
  });
}
