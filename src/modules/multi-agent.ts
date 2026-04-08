import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { parse } from '../core/parser.js';
import { execute } from '../core/executor.js';
import { llmStreamChat } from '../utils/llm.js';

// ── Multi-Agent Module ──
// Splits complex requests into parallel sub-tasks and runs them concurrently.

interface AgentRun {
  id: string;
  tasks: string[];
  startedAt: Date;
  status: 'running' | 'completed' | 'failed';
  results: Array<{ task: string; success: boolean; message: string }>;
}

const activeAgents = new Map<string, AgentRun>();
let agentCounter = 0;

// ── Task Splitting ──

function trySplitSimple(input: string): string[] | null {
  // Numbered list: "1. do X 2. do Y 3. do Z"
  const numbered = input.match(/\d+\.\s+[^0-9]+/g);
  if (numbered && numbered.length >= 2) {
    return numbered.map(s => s.replace(/^\d+\.\s+/, '').trim()).filter(Boolean);
  }

  // Split on " and " or commas, but only if we get 2+ meaningful chunks
  // Remove leading trigger phrases first
  const cleaned = input
    .replace(/^(do these|do all|parallel|simultaneously|at the same time)[:\s]*/i, '')
    .trim();

  // Try comma + "and" split: "check weather, play jazz, and search flights"
  const parts = cleaned
    .split(/,\s*(?:and\s+)?|\s+and\s+/i)
    .map(s => s.trim())
    .filter(s => s.length > 3);

  if (parts.length >= 2) return parts;

  return null;
}

async function splitWithLLM(input: string): Promise<string[]> {
  const systemPrompt = `You are a task splitter. Given a complex request, break it into independent sub-tasks that can run in parallel. Return ONLY a JSON array of task strings. Each task should be a standalone natural language command. Example: ["check the weather in NYC", "play jazz music", "search for flights to LA"]. Return ONLY the JSON array, no other text.`;

  const response = await llmStreamChat(
    [{ role: 'user', content: `Split this into parallel tasks: "${input}"` }],
    systemPrompt,
    () => {},
  );

  let cleaned = response.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  const parsed = JSON.parse(cleaned) as string[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('LLM returned no tasks');
  }
  return parsed;
}

// ── Parallel Execution ──

async function runTasksInParallel(tasks: string[]): Promise<AgentRun> {
  agentCounter++;
  const id = `agent-${agentCounter}-${Date.now().toString(36)}`;

  const run: AgentRun = {
    id,
    tasks,
    startedAt: new Date(),
    status: 'running',
    results: [],
  };

  activeAgents.set(id, run);

  const promises = tasks.map(async (task) => {
    try {
      const parsed = await parse(task);
      if (!parsed) {
        return { task, success: false, message: `Could not parse task: "${task}"` };
      }
      const result = await execute(parsed);
      return { task, success: result.success, message: result.message };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { task, success: false, message: `Error: ${errMsg}` };
    }
  });

  const settled = await Promise.allSettled(promises);

  run.results = settled.map((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      return outcome.value;
    }
    return { task: tasks[i], success: false, message: `Rejected: ${outcome.reason}` };
  });

  const allOk = run.results.every(r => r.success);
  run.status = allOk ? 'completed' : 'failed';

  // Keep in map for status queries; clean up after 5 minutes
  setTimeout(() => activeAgents.delete(id), 5 * 60 * 1000);

  return run;
}

function formatRunResults(run: AgentRun): string {
  const lines = [`Parallel run ${run.id} — ${run.status}`];
  for (const r of run.results) {
    const icon = r.success ? '[OK]' : '[FAIL]';
    lines.push(`  ${icon} ${r.task}: ${r.message.slice(0, 200)}`);
  }
  const succeeded = run.results.filter(r => r.success).length;
  lines.push(`\n${succeeded}/${run.results.length} tasks succeeded.`);
  return lines.join('\n');
}

// ── Module Definition ──

const multiAgentModule: JarvisModule = {
  name: 'multi-agent',
  description: 'Run multiple tasks in parallel using sub-agents',

  patterns: [
    {
      intent: 'parallel',
      patterns: [
        /^do these:\s*(.+)/i,
        /^do all\s+(.+)/i,
        /^parallel\s+(.+)/i,
        /^simultaneously\s+(.+)/i,
        /^at the same time\s+(.+)/i,
      ],
      extract: (_match, raw) => ({ input: raw }),
    },
    {
      intent: 'status',
      patterns: [
        /^(?:multi[- ]?agent|parallel)\s+status/i,
        /^agent\s+status/i,
      ],
      extract: (_match, raw) => ({ input: raw }),
    },
  ] as PatternDefinition[],

  async execute(command: ParsedCommand): Promise<CommandResult> {
    const { action, args } = command;
    const input = args.input || args.query || command.raw;

    try {
      if (action === 'status') {
        if (activeAgents.size === 0) {
          return { success: true, message: 'No active or recent parallel agent runs.' };
        }
        const lines: string[] = [];
        for (const [id, run] of activeAgents) {
          lines.push(`${id}: ${run.status} — ${run.tasks.length} tasks (started ${run.startedAt.toLocaleTimeString()})`);
        }
        return { success: true, message: lines.join('\n') };
      }

      // parallel action
      // Step 1: Split the input into sub-tasks
      let tasks = trySplitSimple(input);
      if (!tasks) {
        tasks = await splitWithLLM(input);
      }

      if (tasks.length < 2) {
        return { success: false, message: 'Could not identify multiple tasks to run in parallel. Please separate tasks with commas or "and".' };
      }

      // Step 2: Run all tasks concurrently
      const run = await runTasksInParallel(tasks);

      return {
        success: run.status === 'completed',
        message: formatRunResults(run),
        data: { runId: run.id, results: run.results },
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Multi-agent error: ${errMsg}` };
    }
  },

  getHelp(): string {
    return [
      'Multi-Agent — Run multiple tasks in parallel',
      '',
      'Usage:',
      '  "simultaneously check the weather, play some jazz, and search for flights to NYC"',
      '  "do all: check system status, open Safari, list files in Downloads"',
      '  "parallel search for restaurants and check my calendar"',
      '  "agent status" — check status of recent parallel runs',
    ].join('\n');
  },
};

export default multiAgentModule;
