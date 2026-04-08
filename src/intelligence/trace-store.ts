/**
 * Trace Store — Records every JARVIS interaction as a structured trace.
 *
 * Traces capture input, routing, result, and context for every command.
 * Used by router-policy and learning-engine to optimize behavior over time.
 *
 * Storage: config/traces.json (capped at 5000, oldest pruned).
 * Writes are batched: flushed every 10 traces or on explicit flush().
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Types ──

export interface Trace {
  id: string;
  timestamp: number;
  input: string;
  module: string;
  action: string;
  args: Record<string, string>;
  result: {
    success: boolean;
    message: string;
    latencyMs: number;
  };
  context: {
    timeOfDay: string;
    dayOfWeek: number;
    activeApp?: string;
    voiceMode: boolean;
    previousCommand?: string;
  };
  feedback?: 'positive' | 'negative' | 'neutral';
}

export interface TraceStats {
  totalTraces: number;
  successRate: number;
  topModules: Array<{ module: string; count: number; successRate: number }>;
  topPatterns: Array<{ pattern: string; count: number }>;
  averageLatency: number;
}

interface TraceFile {
  version: number;
  traces: Trace[];
}

// ── Constants ──

const MAX_TRACES = 5000;
const BATCH_SIZE = 10;

// ── State ──

let traceData: TraceFile = { version: 1, traces: [] };
let pendingWrites = 0;
let loaded = false;

// ── Path Resolution ──

function resolveConfigPath(filename: string): string {
  const configDir = join(__dirname, '..', '..', 'config');
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  return join(configDir, filename);
}

function getTracePath(): string {
  return resolveConfigPath('traces.json');
}

// ── Load / Save ──

function load(): void {
  if (loaded) return;
  loaded = true;

  const path = getTracePath();
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      if (raw && Array.isArray(raw.traces)) {
        traceData = raw;
      }
    } catch {
      traceData = { version: 1, traces: [] };
    }
  }
}

function saveNow(): void {
  try {
    writeFileSync(getTracePath(), JSON.stringify(traceData, null, 2), 'utf-8');
  } catch { /* ignore write errors */ }
}

function maybeSave(): void {
  pendingWrites++;
  if (pendingWrites >= BATCH_SIZE) {
    pendingWrites = 0;
    saveNow();
  }
}

// ── Pruning ──

function pruneIfNeeded(): void {
  if (traceData.traces.length > MAX_TRACES) {
    // Remove oldest traces beyond cap
    const excess = traceData.traces.length - MAX_TRACES;
    traceData.traces.splice(0, excess);
  }
}

// ── Public API ──

/**
 * Record a new trace. The `id` field is auto-generated.
 */
export function recordTrace(trace: Omit<Trace, 'id'>): void {
  load();

  const full: Trace = {
    ...trace,
    id: randomUUID(),
  };

  traceData.traces.push(full);
  pruneIfNeeded();
  maybeSave();
}

/**
 * Retrieve traces with optional filters.
 */
export function getTraces(filter?: {
  module?: string;
  since?: number;
  success?: boolean;
}): Trace[] {
  load();

  if (!filter) return [...traceData.traces];

  return traceData.traces.filter(t => {
    if (filter.module && t.module !== filter.module) return false;
    if (filter.since && t.timestamp < filter.since) return false;
    if (filter.success !== undefined && t.result.success !== filter.success) return false;
    return true;
  });
}

/**
 * Compute aggregate statistics over all traces.
 */
export function getStats(): TraceStats {
  load();

  const traces = traceData.traces;
  if (traces.length === 0) {
    return {
      totalTraces: 0,
      successRate: 0,
      topModules: [],
      topPatterns: [],
      averageLatency: 0,
    };
  }

  // Success rate
  const successes = traces.filter(t => t.result.success).length;
  const successRate = successes / traces.length;

  // Module breakdown
  const moduleMap = new Map<string, { count: number; successes: number }>();
  for (const t of traces) {
    const entry = moduleMap.get(t.module) || { count: 0, successes: 0 };
    entry.count++;
    if (t.result.success) entry.successes++;
    moduleMap.set(t.module, entry);
  }
  const topModules = Array.from(moduleMap.entries())
    .map(([module, { count, successes }]) => ({
      module,
      count,
      successRate: count > 0 ? successes / count : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Time-of-day patterns
  const patternMap = new Map<string, number>();
  for (const t of traces) {
    const key = `${t.context.timeOfDay}:${t.module}`;
    patternMap.set(key, (patternMap.get(key) || 0) + 1);
  }
  const topPatterns = Array.from(patternMap.entries())
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  // Average latency
  const totalLatency = traces.reduce((sum, t) => sum + t.result.latencyMs, 0);
  const averageLatency = totalLatency / traces.length;

  return {
    totalTraces: traces.length,
    successRate,
    topModules,
    topPatterns,
    averageLatency,
  };
}

/**
 * Get the success rate for a specific module (0-1). Returns 0 if no traces.
 */
export function getModuleSuccessRate(module: string): number {
  load();

  const moduleTraces = traceData.traces.filter(t => t.module === module);
  if (moduleTraces.length === 0) return 0;

  const successes = moduleTraces.filter(t => t.result.success).length;
  return successes / moduleTraces.length;
}

/**
 * Get time-of-day patterns: maps time buckets to arrays of commands commonly run then.
 */
export function getTimePatterns(): Map<string, string[]> {
  load();

  // Aggregate: for each time bucket, count command occurrences
  const bucketCounts = new Map<string, Map<string, number>>();

  for (const t of traceData.traces) {
    const bucket = t.context.timeOfDay;
    if (!bucketCounts.has(bucket)) bucketCounts.set(bucket, new Map());
    const cmdMap = bucketCounts.get(bucket)!;
    const key = `${t.module}:${t.action}`;
    cmdMap.set(key, (cmdMap.get(key) || 0) + 1);
  }

  // For each bucket, return commands sorted by frequency
  const result = new Map<string, string[]>();
  for (const [bucket, cmdMap] of bucketCounts) {
    const sorted = Array.from(cmdMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([cmd]) => cmd);
    result.set(bucket, sorted);
  }

  return result;
}

/**
 * Get sequence patterns: pairs of commands that often follow each other.
 */
export function getSequencePatterns(): Array<{ first: string; then: string; count: number }> {
  load();

  const pairCounts = new Map<string, number>();

  for (let i = 1; i < traceData.traces.length; i++) {
    const prev = traceData.traces[i - 1];
    const curr = traceData.traces[i];

    // Only count sequences within 10 minutes of each other
    if (curr.timestamp - prev.timestamp > 10 * 60 * 1000) continue;

    const key = `${prev.module}:${prev.action}|${curr.module}:${curr.action}`;
    pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
  }

  return Array.from(pairCounts.entries())
    .filter(([, count]) => count >= 2) // only pairs that happened at least twice
    .map(([key, count]) => {
      const [first, then] = key.split('|');
      return { first, then, count };
    })
    .sort((a, b) => b.count - a.count);
}

/**
 * Record feedback for a specific trace.
 */
export function inferFeedback(traceId: string, feedback: 'positive' | 'negative'): void {
  load();

  const trace = traceData.traces.find(t => t.id === traceId);
  if (trace) {
    trace.feedback = feedback;
    maybeSave();
  }
}

/**
 * Force-write all pending traces to disk.
 */
export function flushTraces(): void {
  if (pendingWrites > 0) {
    pendingWrites = 0;
    saveNow();
  }
}
