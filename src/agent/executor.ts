import { replan, Plan, PlanStep, StepResult } from './planner.js';
import { CommandResult, ParsedCommand } from '../core/types.js';

// ── Types ──

export type StepExecutor = (toolName: string, command: ParsedCommand) => Promise<CommandResult>;

export type ProgressEvent =
  | { type: 'step_start'; step: PlanStep; totalSteps: number }
  | { type: 'step_complete'; step: PlanStep; result: StepResult }
  | { type: 'step_retry'; step: PlanStep; attempt: number; error: string }
  | { type: 'step_skipped'; step: PlanStep; reason: string }
  | { type: 'replanning'; failedStep: PlanStep; error: string }
  | { type: 'aborted'; step: PlanStep; error: string }
  | { type: 'plan_complete'; results: StepResult[] };

export type ProgressCallback = (event: ProgressEvent) => void;

export interface AgentResult {
  success: boolean;
  goal: string;
  completedSteps: StepResult[];
  failedStep?: PlanStep;
  error?: string;
  aborted: boolean;
  replanned: boolean;
}

// ── Constants ──

const MAX_RETRIES = 3;
const MAX_REPLANS = 2;

// ── Helpers ──

function buildParsedCommand(step: PlanStep, contextParams: Record<string, string>): ParsedCommand {
  // Merge context from previous steps into parameters
  const mergedParams = { ...step.parameters, ...contextParams };

  return {
    module: step.tool as ParsedCommand['module'],
    action: step.action,
    args: mergedParams,
    raw: `${step.tool} ${step.action} ${Object.entries(mergedParams).map(([k, v]) => `${k}="${v}"`).join(' ')}`,
    confidence: 1.0,
  };
}

function extractContextFromResults(completedSteps: StepResult[]): Record<string, string> {
  const context: Record<string, string> = {};

  for (const result of completedSteps) {
    if (!result.success) continue;

    // Store output keyed by step number and tool for downstream steps
    const prefix = `step${result.step.stepNum}`;
    context[`${prefix}_output`] = result.output.slice(0, 500);
    context[`${prefix}_tool`] = result.step.tool;

    // If data contains structured info, flatten top-level string fields
    if (result.data && typeof result.data === 'object') {
      const data = result.data as Record<string, unknown>;
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string') {
          context[`${prefix}_${key}`] = value;
        }
      }
    }
  }

  return context;
}

// ── Executor ──

export async function executeAgentPlan(
  plan: Plan,
  executeStep: StepExecutor,
  onProgress: ProgressCallback,
): Promise<AgentResult> {
  const completedSteps: StepResult[] = [];
  let replanned = false;
  let replanCount = 0;
  let currentPlan = plan;

  for (let i = 0; i < currentPlan.steps.length; i++) {
    const step = currentPlan.steps[i];
    const contextParams = extractContextFromResults(completedSteps);

    onProgress({ type: 'step_start', step, totalSteps: currentPlan.steps.length });

    let lastError = '';
    let succeeded = false;

    // Retry loop
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const command = buildParsedCommand(step, contextParams);
        const result = await executeStep(step.tool, command);

        const stepResult: StepResult = {
          step,
          success: result.success,
          output: result.message,
          data: result.data,
        };

        if (result.success) {
          completedSteps.push(stepResult);
          onProgress({ type: 'step_complete', step, result: stepResult });
          succeeded = true;
          break;
        } else {
          lastError = result.message;
          if (attempt < MAX_RETRIES) {
            onProgress({ type: 'step_retry', step, attempt, error: lastError });
          }
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_RETRIES) {
          onProgress({ type: 'step_retry', step, attempt, error: lastError });
        }
      }
    }

    if (succeeded) continue;

    // Step failed after all retries
    if (!step.critical) {
      // Non-critical: skip and continue
      const skipResult: StepResult = {
        step,
        success: false,
        output: `Skipped after ${MAX_RETRIES} failures: ${lastError}`,
      };
      completedSteps.push(skipResult);
      onProgress({ type: 'step_skipped', step, reason: lastError });
      continue;
    }

    // Critical step failed — attempt replan
    if (replanCount < MAX_REPLANS) {
      onProgress({ type: 'replanning', failedStep: step, error: lastError });

      try {
        const availableTools = Array.from(new Set(currentPlan.steps.map(s => s.tool)));
        const newPlan = await replan(
          currentPlan.goal,
          completedSteps,
          step,
          lastError,
          availableTools,
        );

        currentPlan = newPlan;
        replanned = true;
        replanCount++;
        i = -1; // Reset loop — will increment to 0
        continue;
      } catch {
        // Replan itself failed — abort
      }
    }

    // Abort
    onProgress({ type: 'aborted', step, error: lastError });
    return {
      success: false,
      goal: plan.goal,
      completedSteps,
      failedStep: step,
      error: lastError,
      aborted: true,
      replanned,
    };
  }

  onProgress({ type: 'plan_complete', results: completedSteps });

  return {
    success: completedSteps.every(r => r.success),
    goal: plan.goal,
    completedSteps,
    aborted: false,
    replanned,
  };
}
