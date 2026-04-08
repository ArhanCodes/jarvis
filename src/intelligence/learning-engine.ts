/**
 * Learning Engine — Higher-level analysis that improves JARVIS over time.
 *
 * Analyzes accumulated traces to detect habits, preferences, failure patterns,
 * and optimization opportunities. Persists learning state to config/learning-state.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  getTraces,
  getStats,
  getModuleSuccessRate,
  getTimePatterns,
  getSequencePatterns,
  type Trace,
} from './trace-store.js';
import { analyzeTraces as rustAnalyzeTraces, detectHabits as rustDetectHabits, isSidecarAvailable } from '../utils/rust-bridge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Types ──

export interface LearningInsight {
  type: 'habit' | 'preference' | 'failure_pattern' | 'optimization';
  description: string;
  confidence: number;
  actionable: boolean;
  suggestedAction?: string;
}

interface LearningState {
  version: number;
  lastAnalysis: number;
  insights: LearningInsight[];
  suggestedAutomations: Array<{
    sequence: string[];
    occurrences: number;
    suggested: boolean;
  }>;
  knownPreferences: Record<string, string>;
}

// ── Constants ──

const HABIT_MIN_OCCURRENCES = 3;
const FAILURE_RATE_THRESHOLD = 0.4; // flag modules failing 40%+ of the time
const AUTOMATION_THRESHOLD = 3; // suggest automation after 3 repeats of a sequence

// ── State ──

let learningState: LearningState = {
  version: 1,
  lastAnalysis: 0,
  insights: [],
  suggestedAutomations: [],
  knownPreferences: {},
};
let stateLoaded = false;

// ── Path Resolution ──

function resolveConfigPath(filename: string): string {
  const configDir = join(__dirname, '..', '..', 'config');
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  return join(configDir, filename);
}

function getStatePath(): string {
  return resolveConfigPath('learning-state.json');
}

// ── Load / Save ──

function loadState(): void {
  if (stateLoaded) return;
  stateLoaded = true;

  const path = getStatePath();
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      if (raw && typeof raw.version === 'number') {
        learningState = raw;
      }
    } catch {
      // Use default state
    }
  }
}

function saveState(): void {
  try {
    writeFileSync(getStatePath(), JSON.stringify(learningState, null, 2), 'utf-8');
  } catch { /* ignore */ }
}

// ── Helpers ──

function getTimeBucketLabel(bucket: string): string {
  const labels: Record<string, string> = {
    morning: 'in the morning (6am-12pm)',
    afternoon: 'in the afternoon (12pm-5pm)',
    evening: 'in the evening (5pm-9pm)',
    night: 'at night (9pm-6am)',
  };
  return labels[bucket] || bucket;
}

function getDayName(day: number): string {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day] || 'unknown';
}

/**
 * Detect sequences of 2-4 commands that repeat.
 */
function findRepeatedSequences(traces: Trace[]): Array<{ sequence: string[]; count: number }> {
  const sequenceCounts = new Map<string, { sequence: string[]; count: number }>();

  // Look for sequences of length 2 and 3
  for (const seqLen of [2, 3]) {
    for (let i = 0; i <= traces.length - seqLen; i++) {
      const window = traces.slice(i, i + seqLen);

      // Check that all commands are within 15 minutes of each other
      const timeDiff = window[window.length - 1].timestamp - window[0].timestamp;
      if (timeDiff > 15 * 60 * 1000) continue;

      const commands = window.map(t => `${t.module}:${t.action}`);
      const key = commands.join(' -> ');

      const existing = sequenceCounts.get(key) || { sequence: commands, count: 0 };
      existing.count++;
      sequenceCounts.set(key, existing);
    }
  }

  return Array.from(sequenceCounts.values())
    .filter(s => s.count >= AUTOMATION_THRESHOLD)
    .sort((a, b) => b.count - a.count);
}

// ── Public API ──

/**
 * Run full analysis on trace history and return insights.
 */
export function analyzeTraces(): LearningInsight[] {
  loadState();

  const traces = getTraces();
  if (traces.length < 10) {
    return [{ type: 'habit', description: 'Not enough data yet. Keep using JARVIS to build trace history.', confidence: 1, actionable: false }];
  }

  const insights: LearningInsight[] = [];

  // 1. Detect habits: time-of-day patterns
  const timePatterns = getTimePatterns();
  for (const [bucket, commands] of timePatterns) {
    const bucketTraces = traces.filter(t => t.context.timeOfDay === bucket);
    for (const cmd of commands.slice(0, 3)) {
      const cmdTraces = bucketTraces.filter(t => `${t.module}:${t.action}` === cmd);
      if (cmdTraces.length >= HABIT_MIN_OCCURRENCES) {
        const [mod, action] = cmd.split(':');
        insights.push({
          type: 'habit',
          description: `You run "${action}" (${mod}) ${getTimeBucketLabel(bucket)} — ${cmdTraces.length} times observed.`,
          confidence: Math.min(cmdTraces.length / 10, 1.0),
          actionable: true,
          suggestedAction: `Schedule "${action}" to run automatically ${getTimeBucketLabel(bucket)}.`,
        });
      }
    }
  }

  // 2. Detect day-of-week habits
  const dayBuckets = new Map<number, Map<string, number>>();
  for (const t of traces) {
    const day = t.context.dayOfWeek;
    if (!dayBuckets.has(day)) dayBuckets.set(day, new Map());
    const cmdMap = dayBuckets.get(day)!;
    const key = `${t.module}:${t.action}`;
    cmdMap.set(key, (cmdMap.get(key) || 0) + 1);
  }
  for (const [day, cmdMap] of dayBuckets) {
    for (const [cmd, count] of cmdMap) {
      if (count >= HABIT_MIN_OCCURRENCES) {
        const [mod, action] = cmd.split(':');
        // Only flag if this command is disproportionately on this day
        const totalCount = traces.filter(t => `${t.module}:${t.action}` === cmd).length;
        const ratio = count / totalCount;
        if (ratio > 0.4 && totalCount >= 5) {
          insights.push({
            type: 'habit',
            description: `You tend to use "${action}" (${mod}) on ${getDayName(day)}s — ${count} of ${totalCount} uses.`,
            confidence: ratio,
            actionable: false,
          });
        }
      }
    }
  }

  // 3. Detect preferences: when a user consistently uses one module over alternatives
  const moduleUsage = new Map<string, number>();
  for (const t of traces) {
    moduleUsage.set(t.module, (moduleUsage.get(t.module) || 0) + 1);
  }
  const sorted = Array.from(moduleUsage.entries()).sort((a, b) => b[1] - a[1]);
  if (sorted.length >= 2) {
    const [topMod, topCount] = sorted[0];
    const totalCommands = traces.length;
    if (topCount / totalCommands > 0.3) {
      insights.push({
        type: 'preference',
        description: `Your most-used module is "${topMod}" (${Math.round(topCount / totalCommands * 100)}% of commands).`,
        confidence: topCount / totalCommands,
        actionable: false,
      });
    }
  }

  // 4. Detect failure patterns
  const moduleSet = new Set(traces.map(t => t.module));
  for (const mod of moduleSet) {
    const modTraces = traces.filter(t => t.module === mod);
    if (modTraces.length < 3) continue;

    const failRate = 1 - getModuleSuccessRate(mod);
    if (failRate >= FAILURE_RATE_THRESHOLD) {
      // Find common error messages
      const errors = modTraces
        .filter(t => !t.result.success)
        .map(t => t.result.message)
        .slice(0, 5);

      insights.push({
        type: 'failure_pattern',
        description: `Module "${mod}" fails ${Math.round(failRate * 100)}% of the time (${modTraces.length} total uses).`,
        confidence: Math.min(modTraces.length / 20, 1.0),
        actionable: true,
        suggestedAction: errors.length > 0
          ? `Common errors: ${errors.slice(0, 2).join('; ')}`
          : `Consider debugging or avoiding this module.`,
      });
    }
  }

  // 5. Suggest optimizations: repeated sequences
  const repeated = findRepeatedSequences(traces);
  for (const seq of repeated.slice(0, 5)) {
    insights.push({
      type: 'optimization',
      description: `You often run this sequence (${seq.count}x): ${seq.sequence.join(' -> ')}`,
      confidence: Math.min(seq.count / 5, 1.0),
      actionable: true,
      suggestedAction: `Create a workflow that combines: ${seq.sequence.join(', ')}`,
    });
  }

  // Persist
  learningState.insights = insights;
  learningState.lastAnalysis = Date.now();
  saveState();

  return insights;
}

/**
 * Get failure analysis per module: common errors and fail rates.
 */
export function getFailureAnalysis(): Array<{ module: string; commonErrors: string[]; failRate: number }> {
  const traces = getTraces();
  const moduleSet = new Set(traces.map(t => t.module));
  const results: Array<{ module: string; commonErrors: string[]; failRate: number }> = [];

  for (const mod of moduleSet) {
    const modTraces = traces.filter(t => t.module === mod);
    if (modTraces.length < 2) continue;

    const failures = modTraces.filter(t => !t.result.success);
    const failRate = failures.length / modTraces.length;

    if (failRate > 0) {
      // Deduplicate error messages
      const errorCounts = new Map<string, number>();
      for (const f of failures) {
        const msg = f.result.message.slice(0, 100); // truncate long messages
        errorCounts.set(msg, (errorCounts.get(msg) || 0) + 1);
      }
      const commonErrors = Array.from(errorCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([msg, count]) => `${msg} (${count}x)`);

      results.push({ module: mod, commonErrors, failRate });
    }
  }

  return results.sort((a, b) => b.failRate - a.failRate);
}

/**
 * Run trace analytics through Rust sidecar for richer + faster results.
 * Falls back to TS analysis if sidecar is unavailable.
 */
export async function analyzeTracesRust(): Promise<LearningInsight[]> {
  const traces = getTraces();
  if (traces.length < 10) {
    return analyzeTraces();
  }

  try {
    if (!(await isSidecarAvailable())) return analyzeTraces();

    const [analytics, habits] = await Promise.all([
      rustAnalyzeTraces(traces),
      rustDetectHabits(traces, HABIT_MIN_OCCURRENCES),
    ]);

    if (!analytics) return analyzeTraces();

    const insights: LearningInsight[] = [];

    // Habits from Rust
    if (habits) {
      for (const h of habits.slice(0, 10)) {
        const [mod, action] = h.command.split(':');
        insights.push({
          type: 'habit',
          description: `You run "${action}" (${mod}) ${getTimeBucketLabel(h.time_of_day)}${h.day_of_week != null ? ` on ${getDayName(h.day_of_week)}s` : ''} — ${h.occurrences} times (${Math.round(h.regularity * 100)}% regularity).`,
          confidence: h.regularity,
          actionable: h.regularity > 0.3,
          suggestedAction: h.regularity > 0.3 ? `Schedule "${action}" automatically.` : undefined,
        });
      }
    }

    // Failure hotspots from Rust
    for (const f of analytics.failure_hotspots) {
      if (f.failure_rate >= FAILURE_RATE_THRESHOLD) {
        insights.push({
          type: 'failure_pattern',
          description: `"${f.action}" (${f.module}) fails ${Math.round(f.failure_rate * 100)}% of the time (${f.failure_count}/${f.total_count}).`,
          confidence: Math.min(f.total_count / 20, 1.0),
          actionable: true,
          suggestedAction: f.common_error ? `Common error: ${f.common_error}` : undefined,
        });
      }
    }

    // Sequences from Rust
    for (const s of analytics.sequence_patterns.slice(0, 5)) {
      insights.push({
        type: 'optimization',
        description: `You often run: ${s.first} -> ${s.then} (${s.count}x)`,
        confidence: Math.min(s.count / 5, 1.0),
        actionable: true,
        suggestedAction: `Create a workflow combining these commands.`,
      });
    }

    // Persist
    learningState.insights = insights;
    learningState.lastAnalysis = Date.now();
    saveState();

    return insights;
  } catch {
    return analyzeTraces();
  }
}

/**
 * Generate a human-readable usage report.
 */
export function getUsageReport(): string {
  const stats = getStats();
  const traces = getTraces();

  if (traces.length === 0) {
    return 'No JARVIS usage data recorded yet. Start using commands to build your trace history.';
  }

  const lines: string[] = [];
  lines.push('=== JARVIS Usage Report ===');
  lines.push('');

  // Overview
  lines.push(`Total interactions: ${stats.totalTraces}`);
  lines.push(`Overall success rate: ${Math.round(stats.successRate * 100)}%`);
  lines.push(`Average response time: ${Math.round(stats.averageLatency)}ms`);
  lines.push('');

  // Top modules
  if (stats.topModules.length > 0) {
    lines.push('Top modules:');
    for (const m of stats.topModules.slice(0, 5)) {
      lines.push(`  ${m.module}: ${m.count} uses (${Math.round(m.successRate * 100)}% success)`);
    }
    lines.push('');
  }

  // Time patterns
  if (stats.topPatterns.length > 0) {
    lines.push('Time-of-day patterns:');
    for (const p of stats.topPatterns.slice(0, 5)) {
      lines.push(`  ${p.pattern}: ${p.count} times`);
    }
    lines.push('');
  }

  // Sequence patterns
  const sequences = getSequencePatterns();
  if (sequences.length > 0) {
    lines.push('Common command sequences:');
    for (const s of sequences.slice(0, 5)) {
      lines.push(`  ${s.first} -> ${s.then} (${s.count}x)`);
    }
    lines.push('');
  }

  // Failure analysis
  const failures = getFailureAnalysis();
  const problematic = failures.filter(f => f.failRate >= FAILURE_RATE_THRESHOLD);
  if (problematic.length > 0) {
    lines.push('Modules needing attention:');
    for (const f of problematic.slice(0, 3)) {
      lines.push(`  ${f.module}: ${Math.round(f.failRate * 100)}% failure rate`);
      if (f.commonErrors.length > 0) {
        lines.push(`    Common error: ${f.commonErrors[0]}`);
      }
    }
    lines.push('');
  }

  // Recent activity
  const last24h = traces.filter(t => t.timestamp > Date.now() - 24 * 60 * 60 * 1000);
  const last7d = traces.filter(t => t.timestamp > Date.now() - 7 * 24 * 60 * 60 * 1000);
  lines.push(`Activity: ${last24h.length} commands today, ${last7d.length} this week.`);

  return lines.join('\n');
}

/**
 * Check if a command is part of a repeated sequence that should be automated.
 * Returns the full routine sequence if automation is warranted.
 */
export function shouldSuggestAutomation(command: string): { suggest: boolean; routine: string[] } | null {
  loadState();

  const traces = getTraces();
  if (traces.length < 10) return null;

  const repeated = findRepeatedSequences(traces);

  for (const seq of repeated) {
    if (seq.sequence.includes(command) && seq.count >= AUTOMATION_THRESHOLD) {
      // Check if we already suggested this
      const key = seq.sequence.join(',');
      const existing = learningState.suggestedAutomations.find(
        a => a.sequence.join(',') === key,
      );

      if (existing && existing.suggested) continue; // already suggested

      // Record that we are suggesting this
      if (!existing) {
        learningState.suggestedAutomations.push({
          sequence: seq.sequence,
          occurrences: seq.count,
          suggested: true,
        });
      } else {
        existing.suggested = true;
        existing.occurrences = seq.count;
      }
      saveState();

      return {
        suggest: true,
        routine: seq.sequence,
      };
    }
  }

  return null;
}
