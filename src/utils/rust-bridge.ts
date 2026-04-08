// ---------------------------------------------------------------------------
// Rust Sidecar Bridge
// ---------------------------------------------------------------------------
// Connects JARVIS to the jarvis-core Rust sidecar for vector search,
// fuzzy matching, and trace analytics. Falls back gracefully when unavailable.

import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SIDECAR_PORT = parseInt(process.env.JARVIS_CORE_PORT ?? '7700', 10);
const SIDECAR_URL = `http://127.0.0.1:${SIDECAR_PORT}`;

let sidecarProcess: ChildProcess | null = null;
let sidecarAvailable = false;
let lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL = 30_000; // 30s

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${SIDECAR_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function isSidecarAvailable(): Promise<boolean> {
  const now = Date.now();
  if (now - lastHealthCheck < HEALTH_CHECK_INTERVAL) {
    return sidecarAvailable;
  }
  lastHealthCheck = now;
  sidecarAvailable = await checkHealth();
  return sidecarAvailable;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function findBinary(): string | null {
  // Look for the compiled binary relative to project root
  const projectRoot = join(__dirname, '..', '..');
  const candidates = [
    join(projectRoot, 'rust-sidecar', 'target', 'release', 'jarvis-core'),
    join(projectRoot, 'rust-sidecar', 'target', 'debug', 'jarvis-core'),
    join(projectRoot, 'bin', 'jarvis-core'),
    '/usr/local/bin/jarvis-core',
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export async function startSidecar(): Promise<boolean> {
  // Already running?
  if (await checkHealth()) {
    sidecarAvailable = true;
    console.log('[rust-bridge] Sidecar already running');
    return true;
  }

  const binary = findBinary();
  if (!binary) {
    console.log('[rust-bridge] Sidecar binary not found — vector search will use TS fallback');
    sidecarAvailable = false;
    return false;
  }

  console.log(`[rust-bridge] Starting sidecar: ${binary}`);
  sidecarProcess = spawn(binary, [], {
    env: { ...process.env, JARVIS_CORE_PORT: String(SIDECAR_PORT) },
    stdio: 'ignore',
    detached: true,
  });

  sidecarProcess.unref();
  sidecarProcess.on('exit', (code) => {
    console.log(`[rust-bridge] Sidecar exited with code ${code}`);
    sidecarAvailable = false;
    sidecarProcess = null;
  });

  // Wait for it to be ready (up to 3s)
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await checkHealth()) {
      sidecarAvailable = true;
      console.log('[rust-bridge] Sidecar ready');
      return true;
    }
  }

  console.log('[rust-bridge] Sidecar failed to start');
  sidecarAvailable = false;
  return false;
}

export function stopSidecar(): void {
  if (sidecarProcess) {
    try {
      sidecarProcess.kill('SIGTERM');
    } catch { /* ignore */ }
    sidecarProcess = null;
  }
  sidecarAvailable = false;
}

// ---------------------------------------------------------------------------
// API Methods
// ---------------------------------------------------------------------------

async function post<T>(path: string, body: unknown): Promise<T | null> {
  if (!(await isSidecarAvailable())) return null;

  try {
    const res = await fetch(`${SIDECAR_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export interface VectorSearchResult {
  id: string;
  text: string;
  score: number;
  metadata: unknown;
}

/**
 * Index a document for vector search.
 */
export async function indexDocument(
  id: string,
  text: string,
  metadata?: Record<string, unknown>,
): Promise<boolean> {
  const result = await post('/index', { id, text, metadata });
  return result !== null;
}

/**
 * Index multiple documents at once.
 */
export async function bulkIndex(
  documents: Array<{ id: string; text: string; metadata?: Record<string, unknown> }>,
): Promise<boolean> {
  const result = await post('/bulk-index', { documents });
  return result !== null;
}

/**
 * Semantic search across indexed documents.
 */
export async function vectorSearch(
  query: string,
  topK = 5,
  threshold = 0.1,
): Promise<VectorSearchResult[]> {
  const results = await post<VectorSearchResult[]>('/search', {
    query,
    top_k: topK,
    threshold,
  });
  return results ?? [];
}

/**
 * Get the embedding vector for a text string.
 */
export async function embedText(text: string): Promise<number[] | null> {
  const result = await post<{ embedding: number[] }>('/embed', { text });
  return result?.embedding ?? null;
}

/**
 * Delete a document from the index.
 */
export async function deleteDocument(id: string): Promise<boolean> {
  if (!(await isSidecarAvailable())) return false;
  try {
    const res = await fetch(`${SIDECAR_URL}/document/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Get stats from the sidecar.
 */
export async function getSidecarStats(): Promise<{
  document_count: number;
  vocab_size: number;
  uptime_seconds: number;
} | null> {
  if (!(await isSidecarAvailable())) return null;
  try {
    const res = await fetch(`${SIDECAR_URL}/stats`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fuzzy Matching (Levenshtein)
// ---------------------------------------------------------------------------

export interface FuzzyMatchResult {
  keyword: string;
  module: string;
  action: string;
  distance: number;
  confidence: number;
}

export interface KeywordEntry {
  keyword: string;
  module: string;
  action: string;
}

/**
 * Fuzzy match input words against a keyword map using Rust Levenshtein.
 * Returns the best match or null.
 */
export async function fuzzyMatch(
  input: string,
  keywords: KeywordEntry[],
  maxDistance = 2,
): Promise<FuzzyMatchResult | null> {
  const result = await post<FuzzyMatchResult | null>('/fuzzy-match', {
    input,
    keywords,
    max_distance: maxDistance,
  });
  return result ?? null;
}

/**
 * Compute Levenshtein distance between two strings via Rust.
 */
export async function levenshtein(a: string, b: string): Promise<number | null> {
  const result = await post<{ distance: number }>('/levenshtein', { a, b });
  return result?.distance ?? null;
}

/**
 * Batch Levenshtein: compare one input against many candidates.
 * Returns only matches within maxDistance, sorted by distance.
 */
export async function batchLevenshtein(
  input: string,
  candidates: string[],
  maxDistance = 3,
): Promise<Array<{ candidate: string; distance: number }>> {
  const result = await post<Array<{ candidate: string; distance: number }>>('/batch-levenshtein', {
    input,
    candidates,
    max_distance: maxDistance,
  });
  return result ?? [];
}

// ---------------------------------------------------------------------------
// Trace Analytics
// ---------------------------------------------------------------------------

export interface TraceAnalytics {
  total_traces: number;
  success_rate: number;
  top_modules: Array<{ module: string; count: number; success_rate: number; avg_latency: number }>;
  top_patterns: Array<{ pattern: string; count: number }>;
  average_latency: number;
  sequence_patterns: Array<{ first: string; then: string; count: number }>;
  time_distribution: Record<string, number>;
  failure_hotspots: Array<{
    module: string;
    action: string;
    failure_count: number;
    total_count: number;
    failure_rate: number;
    common_error: string;
  }>;
}

/**
 * Send traces to Rust for comprehensive analytics.
 * Returns rich stats including sequence patterns, failure hotspots, and time distribution.
 */
export async function analyzeTraces(traces: unknown[]): Promise<TraceAnalytics | null> {
  return await post<TraceAnalytics>('/trace-analytics', { traces });
}

export interface HabitPattern {
  command: string;
  time_of_day: string;
  day_of_week: number | null;
  occurrences: number;
  regularity: number;
}

/**
 * Detect usage habits from trace history.
 */
export async function detectHabits(traces: unknown[], minOccurrences = 3): Promise<HabitPattern[]> {
  const result = await post<HabitPattern[]>('/detect-habits', {
    traces,
    min_occurrences: minOccurrences,
  });
  return result ?? [];
}
