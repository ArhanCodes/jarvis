import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { run, isSafe } from '../utils/shell.js';

export class ScriptRunnerModule implements JarvisModule {
  name = 'script-runner' as const;
  description = 'Run shell commands and scripts';

  patterns: PatternDefinition[] = [
    {
      intent: 'run',
      patterns: [
        /^(?:run|exec|execute)\s+(.+)/i,
        /^\$\s*(.+)/,
        /^shell\s+(.+)/i,
        /^cmd\s+(.+)/i,
      ],
      extract: (match) => ({ command: match[1].trim() }),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    const cmd = command.args.command;
    if (!cmd) {
      return { success: false, message: 'No command specified.' };
    }

    if (!isSafe(cmd)) {
      return { success: false, message: `Blocked dangerous command: "${cmd}"` };
    }

    const result = await run(cmd, { timeout: 30000 });

    if (result.exitCode === 0) {
      const output = result.stdout || '(no output)';
      return { success: true, message: output };
    } else {
      const output = result.stderr || result.stdout || 'Command failed with no output.';
      return { success: false, message: output };
    }
  }

  getHelp(): string {
    return [
      '  Script Runner — execute shell commands',
      '    run <command>    Run a shell command (e.g. "run ls -la")',
      '    $ <command>      Shorthand (e.g. "$ git status")',
      '    shell <command>  Alternative prefix',
    ].join('\n');
  }
}
