import { llmStreamChat } from '../utils/llm.js';

// ── Types ──

export interface PlanStep {
  stepNum: number;
  tool: string;
  action: string;
  description: string;
  parameters: Record<string, string>;
  critical: boolean;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  reasoning: string;
}

export interface StepResult {
  step: PlanStep;
  success: boolean;
  output: string;
  data?: unknown;
}

// ── Prompts ──

function buildPlannerPrompt(availableTools: string[]): string {
  return `You are JARVIS's autonomous planning engine. Your job is to break down a user's goal into a concrete, step-by-step execution plan using the available JARVIS modules.

AVAILABLE MODULES:
${availableTools.map(t => `- ${t}`).join('\n')}

MODULE CAPABILITIES REFERENCE:
- app-launcher: Open/close/switch macOS applications. Actions: open, close, switch. Params: app (app name).
- script-runner: Run shell scripts or CLI commands. Actions: run. Params: script (command string).
- system-monitor: Check CPU, memory, disk, battery, network stats. Actions: status, cpu, memory, disk, battery, network.
- file-ops: Read, write, list, search, move, copy, delete files. Actions: read, write, list, search, move, copy, delete. Params: path, content, query, destination.
- system-control: Volume, brightness, dark mode, notifications, sleep, lock, restart, shutdown, wifi, bluetooth. Actions: volume, brightness, darkmode, notifications, sleep, lock, wifi, bluetooth. Params: level, state (on/off/toggle).
- timer: Set timers, alarms, stopwatch, reminders. Actions: set, alarm, stopwatch, reminder. Params: duration, time, message.
- process-manager: List, kill, inspect running processes. Actions: list, kill, inspect. Params: name, pid, query.
- clipboard: Read, write, history of clipboard. Actions: read, write, history. Params: text.
- window-manager: Resize, move, arrange, fullscreen windows. Actions: resize, move, arrange, fullscreen, tile. Params: app, position, size.
- media-control: Play, pause, next, previous, volume for media. Actions: play, pause, next, previous, volume. Params: level.
- workflow: Run predefined multi-step workflows. Actions: run, list. Params: name.
- ai-chat: General AI conversation, questions, analysis. Actions: chat, ask, analyze. Params: query, topic.
- smart-assist: Intelligent command routing and complex task assistance. Actions: assist, help. Params: query.
- personality: JARVIS personality, greetings, banter. Actions: greet, status, banter.
- weather-news: Weather forecasts and news headlines. Actions: weather, news, forecast. Params: location, topic.
- smart-routines: Predefined routine sequences (morning, night, work, etc). Actions: run, list, create. Params: routine.
- screen-awareness: Screenshot analysis, OCR, screen reading. Actions: screenshot, read, ocr, analyze. Params: region.
- research: Web research, summaries, deep dives. Actions: search, summarize, research. Params: query, topic, depth.
- whatsapp: Send/read WhatsApp messages. Actions: send, read, list. Params: contact, message.
- browser-control: Navigate, interact with browser tabs. Actions: open, navigate, tab, search. Params: url, query.
- site-monitor: Monitor websites for changes/uptime. Actions: add, remove, check, list. Params: url, interval.
- screen-interact: Click, type, scroll on screen via coordinates. Actions: click, type, scroll. Params: x, y, text.
- scheduler: Schedule commands for later execution. Actions: add, remove, list. Params: time, command, recurring.
- conversions: Unit, currency, timezone conversions. Actions: convert. Params: value, from, to.
- dossier: Contact/person info lookup and management. Actions: lookup, add, update, list. Params: name, field, value.
- comms-stack: Unified communications (email, messages). Actions: send, read, list. Params: to, subject, body, channel.

RULES:
1. Maximum 5 steps. Be efficient — combine actions when possible.
2. Only use modules from the AVAILABLE list. Never invent modules.
3. Mark steps as critical=true if failure should abort the entire plan.
4. Order steps logically — later steps may depend on earlier results.
5. Each step must specify a concrete action and parameters.
6. Think about what information each step needs and whether a prior step provides it.

RESPONSE FORMAT (strict JSON, no markdown fences):
{
  "reasoning": "Brief explanation of your approach",
  "steps": [
    {
      "stepNum": 1,
      "tool": "module-name",
      "action": "action-name",
      "description": "What this step does and why",
      "parameters": {"key": "value"},
      "critical": true
    }
  ]
}

Respond ONLY with the JSON object. No other text.`;
}

function buildReplanPrompt(
  goal: string,
  completedSteps: StepResult[],
  failedStep: PlanStep,
  error: string,
  availableTools: string[],
): string {
  const completedSummary = completedSteps
    .map(r => `Step ${r.step.stepNum} (${r.step.tool}/${r.step.action}): ${r.success ? 'OK' : 'FAILED'} — ${r.output.slice(0, 200)}`)
    .join('\n');

  return `You are JARVIS's autonomous re-planning engine. A previous plan partially failed and you must create a NEW plan to complete the original goal.

ORIGINAL GOAL: ${goal}

COMPLETED STEPS:
${completedSummary || '(none)'}

FAILED STEP:
Step ${failedStep.stepNum} (${failedStep.tool}/${failedStep.action}): "${failedStep.description}"
Error: ${error}

AVAILABLE MODULES: ${availableTools.join(', ')}

Create a NEW plan that picks up from where we left off. Do NOT repeat successfully completed steps. Work around the failure if possible (use a different approach or module). Maximum 5 steps.

RESPONSE FORMAT (strict JSON, no markdown fences):
{
  "reasoning": "Brief explanation of your revised approach and how you're working around the failure",
  "steps": [
    {
      "stepNum": 1,
      "tool": "module-name",
      "action": "action-name",
      "description": "What this step does",
      "parameters": {"key": "value"},
      "critical": true
    }
  ]
}

Respond ONLY with the JSON object.`;
}

// ── Parser ──

function parsePlanResponse(raw: string, goal: string): Plan {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  const parsed = JSON.parse(cleaned) as { reasoning: string; steps: PlanStep[] };

  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error('Plan contains no steps');
  }

  // Enforce max 5 steps
  const steps = parsed.steps.slice(0, 5).map((s, i) => ({
    stepNum: i + 1,
    tool: String(s.tool),
    action: String(s.action),
    description: String(s.description),
    parameters: s.parameters && typeof s.parameters === 'object' ? s.parameters : {},
    critical: Boolean(s.critical),
  }));

  return {
    goal,
    steps,
    reasoning: String(parsed.reasoning || ''),
  };
}

// ── Public API ──

export async function createPlan(goal: string, availableTools: string[]): Promise<Plan> {
  const systemPrompt = buildPlannerPrompt(availableTools);
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: `Create an execution plan for this goal: "${goal}"` },
  ];

  const response = await llmStreamChat(messages, systemPrompt, () => {});

  return parsePlanResponse(response, goal);
}

export async function replan(
  goal: string,
  completedSteps: StepResult[],
  failedStep: PlanStep,
  error: string,
  availableTools: string[],
): Promise<Plan> {
  const systemPrompt = buildReplanPrompt(goal, completedSteps, failedStep, error, availableTools);
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: `Create a revised plan to complete the goal: "${goal}"` },
  ];

  const response = await llmStreamChat(messages, systemPrompt, () => {});

  return parsePlanResponse(response, goal);
}
