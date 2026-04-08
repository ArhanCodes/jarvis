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

// ── Initialization ──

import { rebuildIndex } from './memory-index.js';

/**
 * Initialize all intelligence subsystems.
 * Call once at boot after memory is loaded.
 */
export function initIntelligence(): void {
  try {
    rebuildIndex();
  } catch (err) {
    console.error('[intelligence] Failed to rebuild memory index:', err);
  }
}
