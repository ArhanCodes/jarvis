import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { parse } from '../core/parser.js';
import { execute } from '../core/executor.js';
import { run } from '../utils/shell.js';
import { fmt } from '../utils/formatter.js';
import { configPath, readJsonConfig, writeJsonConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('workflow');

interface Workflow {
  name: string;
  steps: string[];
  description?: string;
}

function loadWorkflows(): Record<string, Workflow> {
  return readJsonConfig<Record<string, Workflow>>('workflows.json', {});
}

function saveWorkflows(workflows: Record<string, Workflow>): void {
  writeJsonConfig('workflows.json', workflows);
}

export class WorkflowModule implements JarvisModule {
  name = 'workflow' as const;
  description = 'Create multi-step workflows and run macOS Shortcuts';

  patterns: PatternDefinition[] = [
    // ── Run workflow ──
    {
      intent: 'run-workflow',
      patterns: [
        /^(?:run\s+)?workflow\s+["']?(.+?)["']?$/i,
        /^flow\s+["']?(.+?)["']?$/i,
      ],
      extract: (match) => ({ name: match[1].trim() }),
    },
    // ── Create workflow ──
    {
      intent: 'create-workflow',
      patterns: [
        /^(?:create|new|add)\s+workflow\s+["']?(.+?)["']?\s*:\s*(.+)/i,
        /^(?:create|new|add)\s+workflow\s+["']?(.+?)["']?\s+(?:with|steps)\s+(.+)/i,
      ],
      extract: (match) => ({ name: match[1].trim(), steps: match[2].trim() }),
    },
    // ── List workflows ──
    {
      intent: 'list-workflows',
      patterns: [
        /^(?:list|show)\s+workflows/i,
        /^workflows$/i,
      ],
      extract: () => ({}),
    },
    // ── Delete workflow ──
    {
      intent: 'delete-workflow',
      patterns: [
        /^(?:delete|remove)\s+workflow\s+["']?(.+?)["']?$/i,
      ],
      extract: (match) => ({ name: match[1].trim() }),
    },
    // ── macOS Shortcuts ──
    {
      intent: 'run-shortcut',
      patterns: [
        /^(?:run\s+)?shortcut\s+["']?(.+?)["']?$/i,
        /^shortcuts?\s+run\s+["']?(.+?)["']?$/i,
      ],
      extract: (match) => ({ name: match[1].trim() }),
    },
    {
      intent: 'list-shortcuts',
      patterns: [
        /^(?:list|show)\s+shortcuts/i,
        /^shortcuts$/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'run-workflow': return this.runWorkflow(command.args.name);
      case 'create-workflow': return this.createWorkflow(command.args.name, command.args.steps);
      case 'list-workflows': return this.listWorkflows();
      case 'delete-workflow': return this.deleteWorkflow(command.args.name);
      case 'run-shortcut': return this.runShortcut(command.args.name);
      case 'list-shortcuts': return this.listShortcuts();
      default: return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  // ── Workflows ──
  private async runWorkflow(name: string): Promise<CommandResult> {
    const workflows = loadWorkflows();
    const key = name.toLowerCase();
    const workflow = Object.entries(workflows).find(
      ([k]) => k.toLowerCase() === key
    );

    if (!workflow) {
      return { success: false, message: `Workflow "${name}" not found. Use "workflows" to list.` };
    }

    const [, wf] = workflow;
    console.log(fmt.dim(`  Running workflow "${wf.name}" (${wf.steps.length} steps)...`));

    const results: CommandResult[] = [];
    for (let i = 0; i < wf.steps.length; i++) {
      const step = wf.steps[i];
      console.log(fmt.dim(`  [${i + 1}/${wf.steps.length}] ${step}`));

      const parsed = await parse(step);
      if (!parsed) {
        console.log(fmt.error(`  Step failed: could not parse "${step}"`));
        results.push({ success: false, message: `Could not parse: ${step}` });
        continue;
      }

      const result = await execute(parsed);
      results.push(result);
      if (result.success) {
        console.log(fmt.success(result.message));
      } else {
        console.log(fmt.error(result.message));
      }
    }

    const passed = results.filter(r => r.success).length;
    return {
      success: passed === results.length,
      message: `Workflow "${wf.name}" complete: ${passed}/${results.length} steps succeeded`,
    };
  }

  private createWorkflow(name: string, stepsStr: string): CommandResult {
    const steps = stepsStr.split(/\s*(?:&&|,|then)\s*/i).map(s => s.trim()).filter(Boolean);
    if (steps.length === 0) {
      return { success: false, message: 'No steps provided. Separate steps with "&&", ",", or "then".' };
    }

    const workflows = loadWorkflows();
    workflows[name.toLowerCase()] = { name, steps };
    saveWorkflows(workflows);

    return {
      success: true,
      message: `Workflow "${name}" created with ${steps.length} step(s):\n${steps.map((s, i) => `    ${i + 1}. ${s}`).join('\n')}`,
    };
  }

  private listWorkflows(): CommandResult {
    const workflows = loadWorkflows();
    const entries = Object.values(workflows);
    if (entries.length === 0) {
      return { success: true, message: 'No workflows defined. Create one with: create workflow <name>: step1 && step2' };
    }

    const lines = entries.map(wf =>
      `    ${wf.name} (${wf.steps.length} steps)\n${wf.steps.map((s, i) => `      ${i + 1}. ${s}`).join('\n')}`
    );
    return { success: true, message: `Workflows:\n${lines.join('\n\n')}` };
  }

  private deleteWorkflow(name: string): CommandResult {
    const workflows = loadWorkflows();
    const key = Object.keys(workflows).find(k => k.toLowerCase() === name.toLowerCase());
    if (!key) {
      return { success: false, message: `Workflow "${name}" not found` };
    }
    delete workflows[key];
    saveWorkflows(workflows);
    return { success: true, message: `Deleted workflow "${name}"` };
  }

  // ── macOS Shortcuts ──
  private async runShortcut(name: string): Promise<CommandResult> {
    const result = await run(`shortcuts run "${name}" 2>&1`, { timeout: 30000 });
    if (result.exitCode === 0) {
      return { success: true, message: `Shortcut "${name}" executed${result.stdout ? ': ' + result.stdout : ''}` };
    }
    return { success: false, message: `Shortcut failed: ${result.stderr || result.stdout || 'Unknown error'}` };
  }

  private async listShortcuts(): Promise<CommandResult> {
    const result = await run('shortcuts list 2>&1');
    if (result.exitCode !== 0 || !result.stdout) {
      return { success: false, message: 'Could not list Shortcuts. Is Shortcuts.app available?' };
    }
    const shortcuts = result.stdout.split('\n').filter(Boolean);
    const display = shortcuts.slice(0, 30).map(s => `    ${s}`).join('\n');
    const more = shortcuts.length > 30 ? `\n    ... and ${shortcuts.length - 30} more` : '';
    return { success: true, message: `macOS Shortcuts (${shortcuts.length}):\n${display}${more}` };
  }

  getHelp(): string {
    return [
      '  Workflows — multi-step tasks and macOS Shortcuts',
      '    create workflow <name>: step1 && step2 && step3',
      '                           Create a named workflow',
      '    workflow <name>        Run a saved workflow',
      '    workflows              List all workflows',
      '    delete workflow <name> Delete a workflow',
      '    shortcut <name>        Run a macOS Shortcut',
      '    shortcuts              List macOS Shortcuts',
    ].join('\n');
  }
}
