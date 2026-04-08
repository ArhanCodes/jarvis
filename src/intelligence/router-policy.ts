/**
 * Router Policy — Smart routing that learns from traces.
 *
 * Analyzes historical traces to suggest which module should handle a command,
 * predict what the user will do next, and generate personalized greetings.
 *
 * Uses keyword matching, time-of-day patterns, and command sequence analysis.
 */

import { getTraces, getTimePatterns, getSequencePatterns, type Trace } from './trace-store.js';

// ── Types ──

export interface RoutingSuggestion {
  module: string;
  action: string;
  confidence: number;
  reason: string;
}

interface RoutingStats {
  totalPredictions: number;
  correctPredictions: number;
  accuracy: number;
}

// ── Constants ──

const CONFIDENCE_THRESHOLD = 0.6;
const RECENCY_DECAY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'like',
  'through', 'after', 'over', 'between', 'out', 'up', 'down', 'off',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than', 'too',
  'very', 'just', 'because', 'if', 'when', 'where', 'how', 'what',
  'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'i', 'me',
  'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her',
  'it', 'its', 'they', 'them', 'their', 'please', 'hey', 'jarvis',
]);

// ── State for tracking prediction accuracy ──

let stats: RoutingStats = {
  totalPredictions: 0,
  correctPredictions: 0,
  accuracy: 0,
};

// ── Helpers ──

/**
 * Extract meaningful keywords from input text.
 */
function extractKeywords(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Compute a TF-IDF-like similarity score between two keyword arrays.
 * Returns a value between 0 and 1.
 */
function keywordSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;

  const setA = new Set(a);
  const setB = new Set(b);
  let overlap = 0;
  for (const word of setA) {
    if (setB.has(word)) overlap++;
  }

  // Jaccard-like similarity
  const union = new Set([...a, ...b]).size;
  return union > 0 ? overlap / union : 0;
}

/**
 * Calculate a recency weight (1.0 for now, decaying to 0.1 over RECENCY_DECAY_MS).
 */
function recencyWeight(timestamp: number): number {
  const age = Date.now() - timestamp;
  if (age <= 0) return 1.0;
  if (age >= RECENCY_DECAY_MS) return 0.1;
  return 1.0 - (0.9 * age) / RECENCY_DECAY_MS;
}

/**
 * Get the time-of-day bucket for an hour.
 */
function getTimeBucket(hour?: number): string {
  const h = hour ?? new Date().getHours();
  if (h >= 6 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

// ── Public API ──

/**
 * Suggest a module/action routing based on trace history and current context.
 * Returns null if confidence is below threshold.
 */
export function suggestRoute(
  input: string,
  context: { timeOfDay: string; previousCommand?: string; activeApp?: string },
): RoutingSuggestion | null {
  const traces = getTraces();
  if (traces.length < 5) return null; // not enough data

  const inputKeywords = extractKeywords(input);
  if (inputKeywords.length === 0) return null;

  // Score each historical trace for similarity
  const candidates = new Map<string, {
    module: string;
    action: string;
    totalScore: number;
    count: number;
    bestReason: string;
  }>();

  for (const trace of traces) {
    const traceKeywords = extractKeywords(trace.input);
    const similarity = keywordSimilarity(inputKeywords, traceKeywords);
    if (similarity < 0.3) continue; // too dissimilar

    const key = `${trace.module}:${trace.action}`;
    const existing = candidates.get(key) || {
      module: trace.module,
      action: trace.action,
      totalScore: 0,
      count: 0,
      bestReason: '',
    };

    // Score components
    let score = similarity * 0.5; // base keyword similarity

    // Time-of-day bonus
    if (trace.context.timeOfDay === context.timeOfDay) {
      score += 0.15;
    }

    // Sequence bonus: if previous command matches
    if (context.previousCommand && trace.context.previousCommand === context.previousCommand) {
      score += 0.2;
    }

    // Active app bonus
    if (context.activeApp && trace.context.activeApp === context.activeApp) {
      score += 0.1;
    }

    // Recency bonus
    score *= recencyWeight(trace.timestamp);

    // Success penalty/bonus
    if (!trace.result.success) score *= 0.5;
    if (trace.feedback === 'positive') score *= 1.3;
    if (trace.feedback === 'negative') score *= 0.3;

    existing.totalScore += score;
    existing.count++;

    // Build reason string
    if (existing.count > 1) {
      existing.bestReason = `used ${existing.count} times`;
      if (trace.context.timeOfDay === context.timeOfDay) {
        existing.bestReason += ` at this time of day`;
      }
    } else {
      existing.bestReason = `matched similar input`;
    }

    candidates.set(key, existing);
  }

  if (candidates.size === 0) return null;

  // Find best candidate
  let best: { module: string; action: string; confidence: number; reason: string } | null = null;

  for (const [, c] of candidates) {
    // Normalize score: average score * frequency bonus
    const avgScore = c.totalScore / c.count;
    const freqBonus = Math.min(c.count / 10, 1.0); // caps at 10 occurrences
    const confidence = Math.min(avgScore * (0.6 + 0.4 * freqBonus), 1.0);

    if (!best || confidence > best.confidence) {
      best = {
        module: c.module,
        action: c.action,
        confidence,
        reason: c.bestReason,
      };
    }
  }

  if (!best || best.confidence < CONFIDENCE_THRESHOLD) return null;

  stats.totalPredictions++;
  return best;
}

/**
 * Predict what command the user will run next, based on sequence patterns.
 * Returns null if no confident prediction.
 */
export function predictNextCommand(lastCommand: string): string | null {
  const sequences = getSequencePatterns();
  if (sequences.length === 0) return null;

  // Find sequences starting with the last command
  const matching = sequences.filter(s => s.first === lastCommand);
  if (matching.length === 0) return null;

  // Return the most common follow-up
  const top = matching[0]; // already sorted by count
  if (top.count < 2) return null;

  return top.then;
}

/**
 * Generate a personalized greeting based on time patterns and usage history.
 */
export function getPersonalizedGreeting(): string {
  const bucket = getTimeBucket();
  const timePatterns = getTimePatterns();
  const bucketCommands = timePatterns.get(bucket);

  const greetings: Record<string, string> = {
    morning: 'Good morning',
    afternoon: 'Good afternoon',
    evening: 'Good evening',
    night: 'Burning the midnight oil',
  };

  let greeting = greetings[bucket] || 'Hello';

  if (bucketCommands && bucketCommands.length > 0) {
    const topCmd = bucketCommands[0];
    const [mod, action] = topCmd.split(':');
    const readable = action ? `${action} (${mod})` : mod;
    greeting += `. You usually start with ${readable} around now`;
  }

  // Add stats flavor
  const traces = getTraces({ since: Date.now() - 24 * 60 * 60 * 1000 });
  if (traces.length > 0) {
    greeting += `. You ran ${traces.length} command${traces.length === 1 ? '' : 's'} in the last 24h`;
  }

  return greeting + '.';
}

/**
 * Get prediction accuracy stats.
 */
export function getRoutingStats(): RoutingStats {
  return {
    ...stats,
    accuracy: stats.totalPredictions > 0
      ? stats.correctPredictions / stats.totalPredictions
      : 0,
  };
}

/**
 * Record that a prediction was correct (called when the suggested route was actually used).
 */
export function recordCorrectPrediction(): void {
  stats.correctPredictions++;
}
