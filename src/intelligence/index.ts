/**
 * Intelligence Module — Barrel export for all JARVIS intelligence subsystems.
 *
 * Provides trace recording, memory search, context injection, and initialization.
 */

// Trace store
export { recordTrace, getTraces, getStats } from './trace-store.js';

// Memory index (TF-IDF search)
export {
  search as searchMemory,
  hybridSearch,
  searchByType as searchMemoryByType,
  indexDocument,
  rebuildIndex,
  getRelatedDocuments,
  getIndexStats,
} from './memory-index.js';
export type { IndexedDocument, SearchResult } from './memory-index.js';

// Context engine
export {
  buildContext,
  injectContext,
  estimateTokens,
} from './context-engine.js';
export type { ContextBlock, EnrichedContext } from './context-engine.js';

// Learning engine
export {
  analyzeTraces,
  analyzeTracesRust,
  getUsageReport,
  shouldSuggestAutomation,
  getFailureAnalysis,
} from './learning-engine.js';
export type { LearningInsight } from './learning-engine.js';

// ── Initialization ──

import { rebuildIndex } from './memory-index.js';
import { analyzeTracesRust } from './learning-engine.js';
import { getTraces } from './trace-store.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('intelligence');

let learningInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Initialize all intelligence subsystems.
 * Call once at boot after memory is loaded.
 */
export function initIntelligence(): void {
  try {
    rebuildIndex();
  } catch (err) {
    log.error('Failed to rebuild memory index', err);
  }

  // Run learning analysis every 30 minutes if we have enough traces
  learningInterval = setInterval(async () => {
    const traces = getTraces();
    if (traces.length >= 20) {
      try {
        await analyzeTracesRust();
      } catch (err) {
        log.debug('Learning analysis skipped', err);
      }
    }
  }, 30 * 60 * 1000);

  // Run initial analysis after 60s to let traces load
  setTimeout(async () => {
    const traces = getTraces();
    if (traces.length >= 20) {
      try {
        await analyzeTracesRust();
      } catch (err) { log.debug('Learning analysis skipped', err); }
    }
  }, 60_000);
}

export function stopIntelligence(): void {
  if (learningInterval) {
    clearInterval(learningInterval);
    learningInterval = null;
  }
}
