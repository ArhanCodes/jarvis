import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { parse } from '../core/parser.js';
import { execute } from '../core/executor.js';
import { run } from '../utils/shell.js';
import { fmt } from '../utils/formatter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Workflow {
  name: string;
  steps: string[];
  description?: string;
}

interface ScheduledTask {
  id: number;
  command: string;
  cronExpr: string;
  interval: ReturnType<typeof setInterval> | null;
  nextRun: number;
}

let nextSchedId = 1;
const scheduledTasks: Map<number, ScheduledTask> = new Map();

function getWorkflowPath(): string {
  const paths = [
    join(__dirname, '..', '..', 'config', 'workflows.json'),
    join(__dirname, '..', '..', '..', 'config', 'workflows.json'),
  ];
  for (const p of paths) {
    const dir = dirname(p);
    if (existsSync(dir)) return p;
  }
  return paths[0];
}

function loadWorkflows(): Record<string, Workflow> {
  const path = getWorkflowPath();
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

function saveWorkflows(workflows: Record<string, Workflow>): void {
  const path = getWorkflowPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(workflows, null, 2) + '\n');
}

// Simple cron-like interval parser
// Supports: "every 5 min", "every hour", "every 30 seconds", "every day at 9am"
function parseCronInterval(expr: string): number | null {
  const s = expr.toLowerCase().trim();

  const match = s.match(/every\s+(\d+)?\s*(seconds?|mins?|minutes?|hours?|hrs?)/);
  if (match) {
    const val = match[1] ? parseInt(match[1], 10) : 1;
    const unit = match[2].charAt(0);
    if (unit === 's') return val * 1000;
    if (unit === 'm') return val * 60 * 1000;
    if (unit === 'h') return val * 3600 * 1000;
  }

  if (/every\s+day/i.test(s)) return 24 * 3600 * 1000;
  if (/every\s+hour/i.test(s)) return 3600 * 1000;

  return null;
}

export class WorkflowModule implements JarvisModule {
  name = 'workflow' as const;
  description = 'Create multi-step workflows, run macOS Shortcuts, and schedule recurring tasks';

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
    // ── Scheduling ──
    {
      intent: 'schedule',
      patterns: [
        /^(?:schedule|every)\s+(.+?)\s+(?:run|do|exec)\s+(.+)/i,
        /^(?:run|do|exec)\s+(.+?)\s+(every\s+.+)/i,
      ],
      extract: (match) => {
        // Figure out which capture is the interval and which is the command
        if (match[1].toLowerCase().startsWith('every') || /^\d+\s*(s|m|h)/i.test(match[1])) {
          return { interval: match[1].trim(), command: match[2].trim() };
        }
        return { command: match[1].trim(), interval: match[2].trim() };
      },
    },
    {
      intent: 'list-scheduled',
      patterns: [
        /^(?:list|show)\s+(?:scheduled|recurring|cron)/i,
        /^scheduled$/i,
        /^cron$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'cancel-scheduled',
      patterns: [
        /^(?:cancel|stop|remove)\s+(?:scheduled|recurring|cron)\s+(?:#?\s*)?(\d+)/i,
        /^(?:cancel|stop)\s+(?:all\s+)?(?:scheduled|recurring|cron)$/i,
      ],
      extract: (match) => ({ id: match[1] || 'all' }),
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
      case 'schedule': return this.scheduleTask(command.args.interval, command.args.command);
      case 'list-scheduled': return this.listScheduled();
      case 'cancel-scheduled': return this.cancelScheduled(command.args.id);
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

      const parsed = parse(step);
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

  // ── Scheduling ──
  private scheduleTask(intervalStr: string, command: string): CommandResult {
    const intervalMs = parseCronInterval(intervalStr);
    if (!intervalMs) {
      return { success: false, message: `Could not parse interval: "${intervalStr}". Try "every 5 min", "every hour", etc.` };
    }

    const id = nextSchedId++;
    const task: ScheduledTask = {
      id,
      command,
      cronExpr: intervalStr,
      interval: null,
      nextRun: Date.now() + intervalMs,
    };

    task.interval = setInterval(async () => {
      console.log(fmt.dim(`\n  [cron #${id}] Running: ${command}`));
      const parsed = parse(command);
      if (parsed) {
        const result = await execute(parsed);
        if (result.success) {
          console.log(fmt.success(result.message));
        } else {
          console.log(fmt.error(result.message));
        }
      }
      task.nextRun = Date.now() + intervalMs;
      console.log(fmt.prompt());
    }, intervalMs);

    scheduledTasks.set(id, task);

    const intervalDesc = intervalMs < 60000 ? `${intervalMs / 1000}s` :
      intervalMs < 3600000 ? `${intervalMs / 60000}m` : `${intervalMs / 3600000}h`;

    return {
      success: true,
      message: `Scheduled #${id}: "${command}" every ${intervalDesc}`,
    };
  }

  private listScheduled(): CommandResult {
    if (scheduledTasks.size === 0) {
      return { success: true, message: 'No scheduled tasks' };
    }

    const lines: string[] = [];
    for (const task of scheduledTasks.values()) {
      const nextIn = Math.max(0, Math.round((task.nextRun - Date.now()) / 1000));
      lines.push(`    #${task.id}  "${task.command}" — ${task.cronExpr} (next in ${nextIn}s)`);
    }
    return { success: true, message: `Scheduled tasks:\n${lines.join('\n')}` };
  }

  private cancelScheduled(idStr: string): CommandResult {
    if (idStr === 'all') {
      for (const task of scheduledTasks.values()) {
        if (task.interval) clearInterval(task.interval);
      }
      const count = scheduledTasks.size;
      scheduledTasks.clear();
      return { success: true, message: `Cancelled ${count} scheduled task(s)` };
    }

    const id = parseInt(idStr, 10);
    const task = scheduledTasks.get(id);
    if (!task) {
      return { success: false, message: `Scheduled task #${id} not found` };
    }
    if (task.interval) clearInterval(task.interval);
    scheduledTasks.delete(id);
    return { success: true, message: `Cancelled scheduled task #${id}: "${task.command}"` };
  }

  getHelp(): string {
    return [
      '  Workflows & Automation — multi-step tasks and scheduling',
      '    create workflow <name>: step1 && step2 && step3',
      '                           Create a named workflow',
      '    workflow <name>        Run a saved workflow',
      '    workflows              List all workflows',
      '    delete workflow <name> Delete a workflow',
      '    shortcut <name>        Run a macOS Shortcut',
      '    shortcuts              List macOS Shortcuts',
      '    every 5 min run <cmd>  Schedule a recurring command',
      '    scheduled              List scheduled tasks',
      '    cancel scheduled <#>   Cancel a scheduled task',
    ].join('\n');
  }
}
