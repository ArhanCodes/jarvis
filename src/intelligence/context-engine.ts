/**
 * Context Engine — Builds rich, ranked context for LLM calls.
 *
 * Pulls relevant memories, traces, and facts based on the current query,
 * then assembles them into structured context blocks that fit within
 * a token budget. Replaces the simple buildMemoryContext() with
 * semantic-ranked retrieval.
 */

import { getRecentConversation, getSummaries, getAllFacts } from '../core/memory.js';
import { search, searchByType, type SearchResult } from './memory-index.js';

// ── Types ──

export interface ContextBlock {
  source: string;       // "memory", "trace", "conversation", "system"
  relevance: number;    // 0-1
  content: string;
}

export interface EnrichedContext {
  blocks: ContextBlock[];
  totalTokens: number;
  summary: string;
}

// ── Token Estimation ──

/**
 * Rough token estimate: split on whitespace, multiply by 1.3 to account
 * for subword tokenization.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const words = text.trim().split(/\s+/).length;
  return Math.ceil(words * 1.3);
}

// ── Context Building ──

/**
 * Build rich context from the memory index, conversation history, and traces.
 *
 * Searches the index for query-relevant documents, pulls recent conversation
 * turns, and ranks everything by relevance. Truncates to fit within maxTokens.
 */
export function buildContext(
  query: string,
  options?: {
    maxTokens?: number;
    includeTraces?: boolean;
    includeConversation?: boolean;
  },
): EnrichedContext {
  const maxTokens = options?.maxTokens ?? 2000;
  const includeTraces = options?.includeTraces ?? true;
  const includeConversation = options?.includeConversation ?? true;

  const blocks: ContextBlock[] = [];
  let usedTokens = 0;

  // 1. Search memory facts relevant to query
  try {
    const factResults = searchByType(query, 'fact', 10);
    if (factResults.length > 0) {
      const factLines = factResults.map(r => {
        const meta = r.document.metadata;
        return `- ${meta.key || 'info'}: ${r.document.content}`;
      });
      const factContent = factLines.join('\n');
      const tokens = estimateTokens(factContent);

      if (usedTokens + tokens <= maxTokens) {
        blocks.push({
          source: 'memory',
          relevance: normalizeScore(factResults),
          content: factContent,
        });
        usedTokens += tokens;
      }
    }
  } catch {
    // index may not be built yet
  }

  // 2. Always include core facts (user identity, key preferences) even if not query-matched
  try {
    const allFacts = getAllFacts();
    const coreFacts = allFacts.filter(
      f => f.category === 'fact' || f.category === 'preference',
    );
    if (coreFacts.length > 0) {
      const coreLines = coreFacts
        .slice(0, 15)
        .map(f => `- ${f.key}: ${f.value}`);
      const coreContent = coreLines.join('\n');
      const tokens = estimateTokens(coreContent);

      if (usedTokens + tokens <= maxTokens) {
        blocks.push({
          source: 'memory',
          relevance: 0.8, // core facts are always relevant
          content: coreContent,
        });
        usedTokens += tokens;
      }
    }
  } catch {
    // memory not loaded
  }

  // 3. Pull recent conversation context
  if (includeConversation) {
    try {
      const recent = getRecentConversation(5);
      if (recent.length > 0) {
        const convLines = recent.map(
          e => `[${e.role}]: ${truncate(e.content, 200)}`,
        );
        const convContent = convLines.join('\n');
        const tokens = estimateTokens(convContent);

        if (usedTokens + tokens <= maxTokens) {
          blocks.push({
            source: 'conversation',
            relevance: 0.6,
            content: convContent,
          });
          usedTokens += tokens;
        }
      }
    } catch {
      // conversations not loaded
    }
  }

  // 4. Search traces for similar past interactions
  if (includeTraces) {
    try {
      const traceResults = searchByType(query, 'trace', 5);
      if (traceResults.length > 0) {
        const traceLines = traceResults.map(r => {
          const meta = r.document.metadata;
          const success = meta.success === 'true' ? 'OK' : 'FAIL';
          return `- [${success}] ${meta.module}/${meta.action}: ${truncate(r.document.content, 150)}`;
        });
        const traceContent = traceLines.join('\n');
        const tokens = estimateTokens(traceContent);

        if (usedTokens + tokens <= maxTokens) {
          blocks.push({
            source: 'trace',
            relevance: normalizeScore(traceResults),
            content: traceContent,
          });
          usedTokens += tokens;
        }
      }
    } catch {
      // traces not available
    }
  }

  // 5. Include conversation summaries for longer-term context
  try {
    const summaries = getSummaries();
    if (summaries.length > 0) {
      const summaryLines = summaries
        .slice(-3)
        .map(s => `- ${truncate(s.summary, 200)}`);
      const summaryContent = summaryLines.join('\n');
      const tokens = estimateTokens(summaryContent);

      if (usedTokens + tokens <= maxTokens) {
        blocks.push({
          source: 'memory',
          relevance: 0.5,
          content: summaryContent,
        });
        usedTokens += tokens;
      }
    }
  } catch {
    // summaries not loaded
  }

  // 6. Search all document types for any remaining query-relevant context
  try {
    const generalResults = search(query, 5);
    // Filter out docs already covered
    const existingContent = new Set(blocks.map(b => b.content));
    const novel = generalResults.filter(
      r => !existingContent.has(r.document.content),
    );

    if (novel.length > 0) {
      const novelLines = novel.map(
        r => `- [${r.document.type}] ${truncate(r.document.content, 150)}`,
      );
      const novelContent = novelLines.join('\n');
      const tokens = estimateTokens(novelContent);

      if (usedTokens + tokens <= maxTokens) {
        blocks.push({
          source: 'system',
          relevance: normalizeScore(novel),
          content: novelContent,
        });
        usedTokens += tokens;
      }
    }
  } catch {
    // index not ready
  }

  // Sort blocks by relevance (highest first)
  blocks.sort((a, b) => b.relevance - a.relevance);

  // Build summary
  const sourceTypes = [...new Set(blocks.map(b => b.source))];
  const summary =
    blocks.length > 0
      ? `Injected ${blocks.length} context blocks (${sourceTypes.join(', ')}); ~${usedTokens} tokens`
      : 'No relevant context found';

  return {
    blocks,
    totalTokens: usedTokens,
    summary,
  };
}

/**
 * Convenience function: build context and append it to a system prompt.
 *
 * Format:
 *   <original system prompt>
 *
 *   [CONTEXT]
 *   <ranked context blocks>
 */
export function injectContext(systemPrompt: string, query: string): string {
  const ctx = buildContext(query);

  if (ctx.blocks.length === 0) {
    return systemPrompt;
  }

  const sections: string[] = [];

  for (const block of ctx.blocks) {
    const header = `[${block.source.toUpperCase()}]`;
    sections.push(`${header}\n${block.content}`);
  }

  return `${systemPrompt}\n\n[CONTEXT]\n${sections.join('\n\n')}`;
}

// ── Helpers ──

/**
 * Normalize search result scores to 0-1 range.
 */
function normalizeScore(results: SearchResult[]): number {
  if (results.length === 0) return 0;
  const maxScore = Math.max(...results.map(r => r.score));
  // Clamp to 0-1 using sigmoid-like mapping
  return Math.min(1, maxScore / (maxScore + 1));
}

/**
 * Truncate text to a max character length, adding ellipsis if needed.
 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}
