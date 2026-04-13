/**
 * Memory Index — Fast TF-IDF text search over JARVIS memory and conversation data.
 *
 * Provides semantic-like retrieval without external dependencies.
 * Rebuilds in-memory from config/memory.json + config/conversations.json on boot.
 */

import { getAllFacts, getAllConversations, loadMemory } from '../core/memory.js';
import { getTraces, type Trace } from './trace-store.js';
import { isSidecarAvailable, vectorSearch, bulkIndex as sidecarBulkIndex } from '../utils/rust-bridge.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('memory-index');

// ── Types ──

export interface IndexedDocument {
  id: string;
  type: 'fact' | 'conversation' | 'trace' | 'note';
  content: string;
  metadata: Record<string, string>;
  tokens: string[];
  tf: Map<string, number>;
  timestamp: number;
  importance: number;
}

export interface SearchResult {
  document: IndexedDocument;
  score: number;
  matchedTerms: string[];
}

// ── Stop Words ──

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
  'because', 'but', 'and', 'or', 'if', 'while', 'that', 'this', 'these',
  'those', 'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you', 'your',
  'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their', 'what',
  'which', 'who', 'whom', 'about', 'up', 'also',
]);

// ── State ──

const documents: Map<string, IndexedDocument> = new Map();
const invertedIndex: Map<string, Set<string>> = new Map(); // term -> doc IDs
let totalDocCount = 0;

// ── Text Processing ──

/**
 * Simple suffix-based stemmer. No external library needed.
 */
function stem(word: string): string {
  if (word.length < 4) return word;

  // Order matters: check longer suffixes first
  if (word.endsWith('tion')) return word.slice(0, -3); // tion -> t
  if (word.endsWith('sion')) return word.slice(0, -3); // sion -> s
  if (word.endsWith('ment')) return word.slice(0, -3); // ment -> m (keep root + m)
  if (word.endsWith('ness')) return word.slice(0, -4);
  if (word.endsWith('able')) return word.slice(0, -4);
  if (word.endsWith('ible')) return word.slice(0, -4);
  if (word.endsWith('ling') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('ied')) return word.slice(0, -3) + 'y';
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('ly') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.endsWith('es') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);

  return word;
}

/**
 * Tokenize text: lowercase, split on non-alpha, remove stop words, stem.
 */
function tokenize(text: string): string[] {
  const raw = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));

  return raw.map(stem);
}

/**
 * Compute term frequency map for a token list.
 */
function computeTF(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }
  // Normalize by document length
  const len = tokens.length || 1;
  for (const [term, count] of tf) {
    tf.set(term, count / len);
  }
  return tf;
}

/**
 * Compute IDF for a term.
 */
function idf(term: string): number {
  const docsWithTerm = invertedIndex.get(term)?.size || 0;
  if (docsWithTerm === 0) return 0;
  return Math.log((totalDocCount + 1) / (docsWithTerm + 1)) + 1; // smoothed IDF
}

/**
 * Recency boost: recent documents score higher.
 */
function recencyBoost(timestamp: number): number {
  const now = Date.now();
  const msPerDay = 86400000;
  const daysAgo = Math.max((now - timestamp) / msPerDay, 0.01); // avoid div by zero
  return 1 + 0.1 * Math.pow(daysAgo, -0.5);
}

// ── Index Operations ──

/**
 * Add a document to the index. Tokenizes and computes TF on the fly.
 */
export function indexDocument(
  doc: Omit<IndexedDocument, 'tokens' | 'tf'>,
): void {
  const tokens = tokenize(doc.content);
  const tf = computeTF(tokens);

  const indexed: IndexedDocument = {
    ...doc,
    tokens,
    tf,
  };

  // Remove old version if re-indexing
  if (documents.has(doc.id)) {
    removeFromInvertedIndex(doc.id);
  }

  documents.set(doc.id, indexed);
  totalDocCount = documents.size;

  // Update inverted index
  const uniqueTerms = new Set(tokens);
  for (const term of uniqueTerms) {
    if (!invertedIndex.has(term)) {
      invertedIndex.set(term, new Set());
    }
    invertedIndex.get(term)!.add(doc.id);
  }
}

function removeFromInvertedIndex(docId: string): void {
  for (const [, docSet] of invertedIndex) {
    docSet.delete(docId);
  }
}

/**
 * Search the index using TF-IDF scoring with recency and importance boosts.
 */
export function search(query: string, limit = 10): SearchResult[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const scores = new Map<string, { score: number; matchedTerms: string[] }>();

  for (const qTerm of queryTokens) {
    const termIdf = idf(qTerm);
    const matchingDocs = invertedIndex.get(qTerm);
    if (!matchingDocs) continue;

    for (const docId of matchingDocs) {
      const doc = documents.get(docId);
      if (!doc) continue;

      const tfScore = doc.tf.get(qTerm) || 0;
      const tfidf = tfScore * termIdf;

      if (!scores.has(docId)) {
        scores.set(docId, { score: 0, matchedTerms: [] });
      }
      const entry = scores.get(docId)!;
      entry.score += tfidf;
      if (!entry.matchedTerms.includes(qTerm)) {
        entry.matchedTerms.push(qTerm);
      }
    }
  }

  // Apply boosts
  const results: SearchResult[] = [];
  for (const [docId, { score, matchedTerms }] of scores) {
    const doc = documents.get(docId)!;
    const boosted =
      score *
      recencyBoost(doc.timestamp) *
      (1 + doc.importance);

    results.push({ document: doc, score: boosted, matchedTerms });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Search filtered by document type.
 */
export function searchByType(
  query: string,
  type: IndexedDocument['type'],
  limit = 10,
): SearchResult[] {
  const all = search(query, limit * 3); // fetch more, then filter
  return all.filter(r => r.document.type === type).slice(0, limit);
}

/**
 * Find documents related to a given document (by shared terms).
 */
export function getRelatedDocuments(docId: string, limit = 5): SearchResult[] {
  const doc = documents.get(docId);
  if (!doc) return [];

  // Use the document's content as a query, excluding itself
  const queryTokens = doc.tokens;
  if (queryTokens.length === 0) return [];

  const scores = new Map<string, { score: number; matchedTerms: string[] }>();

  for (const qTerm of new Set(queryTokens)) {
    const termIdf = idf(qTerm);
    const matchingDocs = invertedIndex.get(qTerm);
    if (!matchingDocs) continue;

    for (const candidateId of matchingDocs) {
      if (candidateId === docId) continue;
      const candidate = documents.get(candidateId);
      if (!candidate) continue;

      const tfScore = candidate.tf.get(qTerm) || 0;
      const tfidf = tfScore * termIdf;

      if (!scores.has(candidateId)) {
        scores.set(candidateId, { score: 0, matchedTerms: [] });
      }
      const entry = scores.get(candidateId)!;
      entry.score += tfidf;
      if (!entry.matchedTerms.includes(qTerm)) {
        entry.matchedTerms.push(qTerm);
      }
    }
  }

  const results: SearchResult[] = [];
  for (const [candidateId, { score, matchedTerms }] of scores) {
    const candidate = documents.get(candidateId)!;
    const boosted =
      score *
      recencyBoost(candidate.timestamp) *
      (1 + candidate.importance);
    results.push({ document: candidate, score: boosted, matchedTerms });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Rebuild the entire index from existing memory facts, conversations, and traces.
 */
export function rebuildIndex(): void {
  // Clear existing index
  documents.clear();
  invertedIndex.clear();
  totalDocCount = 0;

  try {
    loadMemory();
  } catch (err) {
    log.debug('Memory not initialized yet', err);
  }

  // Index memory facts
  try {
    const facts = getAllFacts();
    for (const fact of facts) {
      indexDocument({
        id: `fact:${fact.key}`,
        type: 'fact',
        content: `${fact.key} ${fact.value} ${fact.source}`,
        metadata: {
          key: fact.key,
          category: fact.category,
          source: fact.source,
        },
        timestamp: fact.updatedAt || fact.createdAt,
        importance: 0.7, // facts are generally important
      });
    }
  } catch (err) {
    log.debug('Failed to index memory facts', err);
  }

  // Index conversation entries
  try {
    const conversations = getAllConversations();
    // Index in chunks of 3 messages for better context
    for (let i = 0; i < conversations.length; i += 3) {
      const chunk = conversations.slice(i, i + 3);
      const content = chunk.map(c => c.content).join(' ');
      const firstEntry = chunk[0];
      indexDocument({
        id: `conv:${firstEntry.timestamp}:${i}`,
        type: 'conversation',
        content,
        metadata: {
          role: firstEntry.role,
          ...(firstEntry.commandExecuted
            ? { command: firstEntry.commandExecuted }
            : {}),
        },
        timestamp: firstEntry.timestamp,
        importance: 0.3, // conversations are lower priority unless accessed
      });
    }
  } catch (err) {
    log.debug('Failed to index conversations', err);
  }

  // Index traces
  try {
    const traces = getTraces();
    for (const trace of traces) {
      indexDocument({
        id: `trace:${trace.id}`,
        type: 'trace',
        content: `${trace.input} ${trace.module} ${trace.action} ${trace.result.message}`,
        metadata: {
          module: trace.module,
          action: trace.action,
          success: String(trace.result.success),
        },
        timestamp: trace.timestamp,
        importance: trace.result.success ? 0.4 : 0.6, // failures are more noteworthy
      });
    }
  } catch (err) {
    log.debug('Failed to index traces', err);
  }

  // Sync to Rust sidecar if available
  syncToSidecar().catch(() => {});
}

/**
 * Hybrid search: tries Rust sidecar first (vector search), falls back to TF-IDF.
 * The sidecar gives better semantic matching; TF-IDF is the always-available fallback.
 */
export async function hybridSearch(query: string, limit = 10): Promise<SearchResult[]> {
  // Try sidecar first
  if (await isSidecarAvailable()) {
    try {
      const results = await vectorSearch(query, limit, 0.1);
      if (results.length > 0) {
        return results.map(r => ({
          document: {
            id: r.id,
            type: (r.metadata as any)?.type ?? 'note',
            content: r.text,
            metadata: (r.metadata as Record<string, string>) ?? {},
            tokens: [],
            tf: new Map(),
            timestamp: Date.now(),
            importance: r.score,
          },
          score: r.score,
          matchedTerms: [],
        }));
      }
    } catch (err) {
      log.debug('Sidecar vector search failed, falling back to TF-IDF', err);
    }
  }

  // Fallback to local TF-IDF
  return search(query, limit);
}

/**
 * Sync all indexed documents to the Rust sidecar (if available).
 * Called after rebuildIndex to keep the sidecar in sync.
 */
async function syncToSidecar(): Promise<void> {
  if (!(await isSidecarAvailable())) return;

  const docs = Array.from(documents.values()).map(doc => ({
    id: doc.id,
    text: doc.content,
    metadata: { ...doc.metadata, type: doc.type, importance: String(doc.importance) },
  }));

  if (docs.length > 0) {
    await sidecarBulkIndex(docs);
    log.info(`Synced ${docs.length} docs to Rust sidecar`);
  }
}

/**
 * Return statistics about the current index.
 */
export function getIndexStats(): {
  totalDocs: number;
  uniqueTerms: number;
  avgDocLength: number;
} {
  let totalTokens = 0;
  for (const doc of documents.values()) {
    totalTokens += doc.tokens.length;
  }

  return {
    totalDocs: documents.size,
    uniqueTerms: invertedIndex.size,
    avgDocLength: documents.size > 0 ? totalTokens / documents.size : 0,
  };
}
