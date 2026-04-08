import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { parse } from '../core/parser.js';
import { execute } from '../core/executor.js';
import { fmt } from '../utils/formatter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Persistence ──

interface PersistedTask {
  id: number;
  command: string;
  intervalMs: number;
  intervalExpr: string;
  createdAt: number;
  lastRun: number | null;
  runCount: number;
}

interface SchedulerData {
  version: number;
  nextId: number;
  tasks: PersistedTask[];
}

interface LiveTask extends PersistedTask {
  timer: ReturnType<typeof setInterval> | null;
}

const liveTasks: Map<number, LiveTask> = new Map();
let nextId = 1;

function getDataPath(): string {
  const paths = [
    join(__dirname, '..', '..', 'config', 'scheduled-tasks.json'),
    join(__dirname, '..', '..', '..', 'config', 'scheduled-tasks.json'),
  ];
  for (const p of paths) {
    const dir = dirname(p);
    if (existsSync(dir)) return p;
  }
  return paths[0];
}

function loadData(): SchedulerData {
  const path = getDataPath();
  try {
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, 'utf-8')) as SchedulerData;
      return data;
    }
  } catch { /* ignore corrupt data */ }
  return { version: 1, nextId: 1, tasks: [] };
}

function saveData(): void {
  const path = getDataPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tasks: PersistedTask[] = [];
  for (const t of liveTasks.values()) {
    tasks.push({
      id: t.id,
      command: t.command,
      intervalMs: t.intervalMs,
      intervalExpr: t.intervalExpr,
      createdAt: t.createdAt,
      lastRun: t.lastRun,
      runCount: t.runCount,
    });
  }

  const data: SchedulerData = { version: 1, nextId, tasks };
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

// ── Interval parser ──
// "every 20 minutes", "every hour", "every 30 seconds", "every 2 hours"
// "every day at 9am" → 24h interval (start delay calculated to hit that time)

interface ParsedInterval {
  intervalMs: number;
  initialDelayMs?: number; // for "at <time>" support
}

function parseInterval(expr: string): ParsedInterval | null {
  const s = expr.toLowerCase().trim();

  // "every <N> <unit>"  or "every <unit>" (implies 1)
  const match = s.match(/(?:every\s+)?(\d+)?\s*(seconds?|secs?|mins?|minutes?|hours?|hrs?|days?)/);
  if (match) {
    const val = match[1] ? parseInt(match[1], 10) : 1;
    const unit = match[2].charAt(0);
    let ms = 0;
    if (unit === 's') ms = val * 1000;
    else if (unit === 'm') ms = val * 60 * 1000;
    else if (unit === 'h') ms = val * 3600 * 1000;
    else if (unit === 'd') ms = val * 24 * 3600 * 1000;
    if (ms > 0) return { intervalMs: ms };
  }

  // "every day at <time>" or "daily at <time>"
  const atMatch = s.match(/(?:every\s+day|daily)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (atMatch) {
    let hour = parseInt(atMatch[1], 10);
    const min = atMatch[2] ? parseInt(atMatch[2], 10) : 0;
    const ampm = atMatch[3];
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    const now = new Date();
    const target = new Date(now);
    target.setHours(hour, min, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    const initialDelayMs = target.getTime() - now.getTime();
    return { intervalMs: 24 * 3600 * 1000, initialDelayMs };
  }

  // "every hour" / "every day" standalone
  if (/every\s+hour/i.test(s)) return { intervalMs: 3600 * 1000 };
  if (/every\s+day/i.test(s)) return { intervalMs: 24 * 3600 * 1000 };

  return null;
}

function formatMs(ms: number): string {
  if (ms < 60000) return `${ms / 1000}s`;
  if (ms < 3600000) return `${ms / 60000}m`;
  if (ms < 86400000) return `${ms / 3600000}h`;
  return `${ms / 86400000}d`;
}

function formatDuration(ms: number): string {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return remSecs ? `${mins}m ${remSecs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins ? `${hours}h ${remMins}m` : `${hours}h`;
}

// ── Task execution ──

function startTask(task: LiveTask): void {
  const run = async () => {
    console.log(fmt.dim(`\n  [scheduled #${task.id}] Running: ${task.command}`));
    const parsed = await parse(task.command);
    if (parsed) {
      const result = await execute(parsed);
      if (result.success) {
        console.log(fmt.success(result.message));
      } else {
        console.log(fmt.error(result.message));
      }
    } else {
      console.log(fmt.error(`  Could not parse scheduled command: "${task.command}"`));
    }
    task.lastRun = Date.now();
    task.runCount++;
    saveData();
    process.stdout.write(fmt.prompt());
  };

  task.timer = setInterval(run, task.intervalMs);
}

function startTaskWithDelay(task: LiveTask, delayMs: number): void {
  // First run after delay, then every intervalMs
  setTimeout(() => {
    // Execute immediately at the scheduled time
    const run = async () => {
      console.log(fmt.dim(`\n  [scheduled #${task.id}] Running: ${task.command}`));
      const parsed = await parse(task.command);
      if (parsed) {
        const result = await execute(parsed);
        if (result.success) {
          console.log(fmt.success(result.message));
        } else {
          console.log(fmt.error(result.message));
        }
      }
      task.lastRun = Date.now();
      task.runCount++;
      saveData();
      process.stdout.write(fmt.prompt());
    };

    run();
    task.timer = setInterval(run, task.intervalMs);
  }, delayMs);
}

// ── Module ──

export class SchedulerModule implements JarvisModule {
  name = 'scheduler' as const;
  description = 'Schedule recurring tasks with natural language intervals';

  patterns: PatternDefinition[] = [
    // ── Create scheduled task ──
    // "every 20 minutes send message to mom"
    // "check sites every hour"
    // "every day at 9am run good morning"
    {
      intent: 'create-task',
      patterns: [
        // "every <interval> run/do <command>" or "every <interval> <command>"
        /^every\s+(.+?)\s+(?:run|do|exec(?:ute)?)\s+(.+)/i,
        // "<command> every <interval>"
        /^(.+?)\s+(every\s+.+)/i,
        // "schedule <interval> run <command>"
        /^schedule\s+(.+?)\s+(?:run|do|exec(?:ute)?)\s+(.+)/i,
      ],
      extract: (match) => {
        const a = match[1].trim();
        const b = match[2].trim();
        // Determine which is the interval and which is the command
        if (/^every\b/i.test(a) || /^\d+\s*(s|m|h|d)/i.test(a) || /\b(seconds?|minutes?|hours?|days?)\b/i.test(a)) {
          return { interval: a, command: b };
        }
        if (/^every\b/i.test(b) || /\b(seconds?|minutes?|hours?|days?)\b/i.test(b)) {
          return { interval: b, command: a };
        }
        // Default: first is interval, second is command
        return { interval: a, command: b };
      },
    },
    // ── List tasks ──
    {
      intent: 'list-tasks',
      patterns: [
        /^(?:list|show)\s+(?:scheduled|recurring|cron)\s*(?:tasks?|jobs?)?$/i,
        /^scheduled\s*(?:tasks?|jobs?)?$/i,
        /^cron\s*(?:tasks?|jobs?)?$/i,
      ],
      extract: () => ({}),
    },
    // ── Cancel task ──
    {
      intent: 'cancel-task',
      patterns: [
        /^(?:cancel|stop|remove|delete)\s+(?:scheduled|recurring|cron)\s+(?:#?\s*)?(\d+)/i,
        /^(?:cancel|stop|remove|delete)\s+(?:all\s+)?(?:scheduled|recurring|cron)(?:\s+(?:tasks?|jobs?))?$/i,
      ],
      extract: (match) => ({ id: match[1] || 'all' }),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'create-task': return this.createTask(command.args.interval, command.args.command);
      case 'list-tasks': return this.listTasks();
      case 'cancel-task': return this.cancelTask(command.args.id);
      default: return { success: false, message: `Unknown scheduler action: ${command.action}` };
    }
  }

  // ── Create ──
  private async createTask(intervalStr: string, command: string): Promise<CommandResult> {
    const parsed = parseInterval(intervalStr);
    if (!parsed) {
      return {
        success: false,
        message: `Could not parse interval: "${intervalStr}". Try "every 5 minutes", "every hour", "every day at 9am".`,
        voiceMessage: `I couldn't understand the interval ${intervalStr}. Try something like every 5 minutes or every hour.`,
      };
    }

    // Minimum interval: 10 seconds
    if (parsed.intervalMs < 10000) {
      return {
        success: false,
        message: 'Minimum interval is 10 seconds.',
        voiceMessage: 'The minimum interval is 10 seconds.',
      };
    }

    // Validate the command parses
    const testParsed = await parse(command);
    if (!testParsed) {
      return {
        success: false,
        message: `Could not parse command: "${command}". Make sure it's a valid JARVIS command.`,
        voiceMessage: `I don't recognize the command: ${command}.`,
      };
    }

    const id = nextId++;
    const task: LiveTask = {
      id,
      command,
      intervalMs: parsed.intervalMs,
      intervalExpr: intervalStr,
      createdAt: Date.now(),
      lastRun: null,
      runCount: 0,
      timer: null,
    };

    liveTasks.set(id, task);

    if (parsed.initialDelayMs !== undefined) {
      startTaskWithDelay(task, parsed.initialDelayMs);
    } else {
      startTask(task);
    }

    saveData();

    const intervalDesc = formatMs(parsed.intervalMs);
    const delayNote = parsed.initialDelayMs
      ? ` (first run in ${formatDuration(parsed.initialDelayMs)})`
      : '';

    return {
      success: true,
      message: `Scheduled #${id}: "${command}" every ${intervalDesc}${delayNote}`,
      voiceMessage: `Scheduled task ${id}: ${command}, every ${intervalDesc}.`,
    };
  }

  // ── List ──
  private listTasks(): CommandResult {
    if (liveTasks.size === 0) {
      return {
        success: true,
        message: 'No scheduled tasks. Create one with: every <interval> run <command>',
        voiceMessage: 'No scheduled tasks.',
      };
    }

    const lines: string[] = [];
    for (const task of liveTasks.values()) {
      const runs = task.runCount > 0 ? `, ran ${task.runCount}x` : '';
      const lastStr = task.lastRun
        ? `, last ${formatDuration(Date.now() - task.lastRun)} ago`
        : '';
      lines.push(`    #${task.id}  "${task.command}" — ${task.intervalExpr}${runs}${lastStr}`);
    }
    return {
      success: true,
      message: `Scheduled tasks (${liveTasks.size}):\n${lines.join('\n')}`,
      voiceMessage: `You have ${liveTasks.size} scheduled task${liveTasks.size === 1 ? '' : 's'}.`,
    };
  }

  // ── Cancel ──
  private cancelTask(idStr: string): CommandResult {
    if (idStr === 'all') {
      for (const task of liveTasks.values()) {
        if (task.timer) clearInterval(task.timer);
      }
      const count = liveTasks.size;
      liveTasks.clear();
      saveData();
      return {
        success: true,
        message: `Cancelled all ${count} scheduled task(s).`,
        voiceMessage: `Cancelled all ${count} scheduled tasks.`,
      };
    }

    const id = parseInt(idStr, 10);
    const task = liveTasks.get(id);
    if (!task) {
      return {
        success: false,
        message: `Scheduled task #${id} not found.`,
        voiceMessage: `Task ${id} not found.`,
      };
    }

    if (task.timer) clearInterval(task.timer);
    liveTasks.delete(id);
    saveData();

    return {
      success: true,
      message: `Cancelled scheduled task #${id}: "${task.command}"`,
      voiceMessage: `Cancelled task ${id}.`,
    };
  }

  // ── Boot restore ──
  restore(): void {
    const data = loadData();
    nextId = data.nextId;

    for (const persisted of data.tasks) {
      const task: LiveTask = { ...persisted, timer: null };
      liveTasks.set(task.id, task);
      startTask(task);
    }

    if (data.tasks.length > 0) {
      console.log(fmt.dim(`  Restored ${data.tasks.length} scheduled task(s)`));
    }
  }

  // ── Shutdown ──
  stopAll(): void {
    for (const task of liveTasks.values()) {
      if (task.timer) clearInterval(task.timer);
    }
    saveData();
  }

  getHelp(): string {
    return [
      '  Scheduler — recurring tasks',
      '    every 5 min run <cmd>    Schedule a command every 5 minutes',
      '    <cmd> every 30 seconds   Schedule with command first',
      '    every day at 9am run <cmd> Daily at a specific time',
      '    scheduled                List scheduled tasks',
      '    cancel scheduled <#>     Cancel a task by ID',
      '    cancel all scheduled     Cancel all tasks',
    ].join('\n');
  }
}
