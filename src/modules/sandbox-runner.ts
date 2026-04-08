import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import {
  isDockerAvailable,
  runInSandbox,
  runCommandInSandbox,
  cleanupSandbox,
} from '../utils/sandbox.js';
import type { SandboxResult } from '../utils/sandbox.js';

export class SandboxRunnerModule implements JarvisModule {
  name = 'sandbox-runner' as const;
  description = 'Run code and commands safely in a sandboxed Docker container';

  patterns: PatternDefinition[] = [
    {
      intent: 'run',
      patterns: [
        /^(?:sandbox\s+run|run\s+safely|safe\s+execute|run\s+in\s+sandbox)\s+(?:this\s+)?(\w+)\s+code[:\s]+(.+)/is,
        /^run\s+(?:this\s+)?(\w+)\s+code\s+in\s+sandbox[:\s]+(.+)/is,
        /^sandbox\s+(\w+)[:\s]+(.+)/is,
      ],
      extract: (_match) => ({
        language: _match[1].trim().toLowerCase(),
        code: _match[2].trim(),
      }),
    },
    {
      intent: 'exec',
      patterns: [
        /^(?:sandbox\s+exec|exec\s+in\s+sandbox|sandbox\s+command)[:\s]+(.+)/is,
        /^(?:safe\s+exec|safely\s+exec(?:ute)?)[:\s]+(.+)/is,
      ],
      extract: (_match) => ({ command: _match[1].trim() }),
    },
    {
      intent: 'status',
      patterns: [
        /^sandbox\s+status$/i,
        /^(?:is\s+)?(?:docker|sandbox)\s+available\??$/i,
        /^check\s+sandbox$/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'run':
        return this.handleRun(command);
      case 'exec':
        return this.handleExec(command);
      case 'status':
        return this.handleStatus();
      default:
        return { success: false, message: `Unknown sandbox action: ${command.action}` };
    }
  }

  // ---------- action handlers ----------

  private async handleRun(command: ParsedCommand): Promise<CommandResult> {
    const { language, code } = command.args;
    if (!language || !code) {
      return { success: false, message: 'Please specify a language and code to run.' };
    }

    const result = await runInSandbox(code, language);
    return this.formatResult(result, `${language} code`);
  }

  private async handleExec(command: ParsedCommand): Promise<CommandResult> {
    const cmd = command.args.command;
    if (!cmd) {
      return { success: false, message: 'No command specified.' };
    }

    const result = await runCommandInSandbox(cmd);
    return this.formatResult(result, `command`);
  }

  private async handleStatus(): Promise<CommandResult> {
    const available = await isDockerAvailable();
    const mode = available
      ? 'Docker is available. Code will run in fully isolated containers.'
      : 'Docker is NOT available. Code will run directly with timeout limits (less safe).';

    return {
      success: true,
      message: `Sandbox status: ${mode}`,
      voiceMessage: available
        ? 'Docker sandbox is available and ready.'
        : 'Docker is not available. I will fall back to direct execution with timeouts.',
    };
  }

  // ---------- helpers ----------

  private formatResult(result: SandboxResult, label: string): CommandResult {
    const modeTag = result.sandboxed ? '[Docker]' : '[Direct fallback]';
    const parts: string[] = [];

    if (result.timedOut) {
      parts.push(`${modeTag} ${label} execution timed out after ${result.executionTime}ms.`);
    } else {
      parts.push(`${modeTag} ${label} exited with code ${result.exitCode} in ${result.executionTime}ms.`);
    }

    if (result.stdout) {
      parts.push(`--- stdout ---\n${result.stdout}`);
    }
    if (result.stderr) {
      parts.push(`--- stderr ---\n${result.stderr}`);
    }
    if (!result.stdout && !result.stderr) {
      parts.push('(no output)');
    }

    if (!result.sandboxed) {
      parts.push('Warning: Docker was not available; code ran without full sandboxing.');
    }

    return {
      success: result.exitCode === 0 && !result.timedOut,
      message: parts.join('\n'),
      voiceMessage: result.timedOut
        ? `The ${label} execution timed out.`
        : result.exitCode === 0
          ? `The ${label} ran successfully.`
          : `The ${label} failed with exit code ${result.exitCode}.`,
    };
  }

  getHelp(): string {
    return [
      '  Sandbox Runner — execute code safely in Docker containers',
      '    sandbox run <lang> code: <code>   Run code (js/python/bash/ts)',
      '    sandbox exec: <command>           Run a shell command in sandbox',
      '    sandbox status                    Check if Docker is available',
      '    run safely python code: print(1)  Alternative phrasing',
      '',
      '  Falls back to direct execution (with timeout) when Docker is unavailable.',
    ].join('\n');
  }
}
