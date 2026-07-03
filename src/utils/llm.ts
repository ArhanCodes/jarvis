import { fetch as undiciFetch, Agent } from 'undici';
import { readJsonConfig, writeJsonConfig } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('llm');

// ── LLM Provider (Claude API) ──

// Default models. Sonnet for real conversation; Haiku for short/cheap work
// (message composition, intent classification, yes/no routing).
export const DEFAULT_MODEL = 'claude-sonnet-4-6';
export const FAST_MODEL = 'claude-haiku-4-5';

interface LLMConfig {
  provider: string;
  claudeApiKey?: string;
  claudeModel?: string;
}

let config: LLMConfig = {
  provider: 'claude',
  claudeModel: DEFAULT_MODEL,
};

function loadLLMConfig(): void {
  const data = readJsonConfig<LLMConfig>('llm-config.json', {} as LLMConfig);
  config = { ...config, ...data };
}

// Load config on module import
loadLLMConfig();

// Keep-alive connection pool so we don't pay a TLS handshake per message.
// JARVIS is long-lived, so idle connections to the API are kept warm.
//
// NOTE: we must use undici's OWN fetch with an explicit `dispatcher`. The
// userland `undici` package and Node's built-in global `fetch` keep their
// global dispatchers in DIFFERENT slots, so `setGlobalDispatcher` from this
// package would NOT attach to a bare `fetch()` call — it'd be a silent no-op.
// Passing the agent per-call guarantees the keep-alive pool is actually used.
const keepAliveAgent = new Agent({
  keepAliveTimeout: 60_000, // keep idle sockets 60s
  keepAliveMaxTimeout: 600_000,
});

export interface LLMOptions {
  /** Override the model (e.g. FAST_MODEL for cheap work). */
  model?: string;
  /** Cache the system prompt with an ephemeral breakpoint (default: true). */
  cache?: boolean;
  /** Max output tokens (default 4096). Lower = faster completion for short replies. */
  maxTokens?: number;
}

// Anthropic message content blocks (text + images for vision).
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

async function claudeStreamChat(
  messages: Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }>,
  systemPrompt: string,
  onToken: (token: string) => void,
  opts: LLMOptions = {},
): Promise<string> {
  if (!config.claudeApiKey) {
    throw new Error('Claude API key not configured. Set claudeApiKey in config/llm-config.json');
  }

  const model = opts.model || config.claudeModel || DEFAULT_MODEL;
  const cache = opts.cache !== false;

  // System prompt as an array with a cache breakpoint. The system prompt is the
  // large, byte-stable part of every call — caching it cuts input cost/latency.
  // Below ~1024 tokens the API simply ignores the breakpoint (no error).
  const system = cache
    ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
    : systemPrompt;

  const response = await undiciFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.claudeApiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 4096,
      system,
      messages,
      stream: true,
    }),
    dispatcher: keepAliveAgent,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error: ${response.status} ${errText}`);
  }

  if (!response.body) throw new Error('No response body from Claude API');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let sseBuffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });

      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data) as {
            type: string;
            delta?: { type: string; text?: string };
            message?: { usage?: Record<string, number> };
          };

          // Confirm caching is working — logged at debug level only.
          if (parsed.type === 'message_start' && parsed.message?.usage) {
            const u = parsed.message.usage;
            log.debug(
              `usage model=${model} cache_read=${u.cache_read_input_tokens ?? 0} ` +
                `cache_write=${u.cache_creation_input_tokens ?? 0} input=${u.input_tokens ?? 0}`,
            );
          }

          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            fullText += parsed.delta.text;
            onToken(parsed.delta.text);
          }
        } catch {
          // Incomplete JSON — will be completed in next chunk
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return fullText;
}

let lastUsedLabel = '';

export function getLastUsedLabel(): string {
  return lastUsedLabel;
}

/**
 * Stream a chat completion from Claude.
 * @param opts.model  Override the model (e.g. FAST_MODEL for short/cheap work).
 * @param opts.cache  Cache the system prompt (default true).
 */
export async function llmStreamChat(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  systemPrompt: string,
  onToken: (token: string) => void,
  opts: LLMOptions = {},
): Promise<string> {
  lastUsedLabel = 'Claude (via API)';
  return claudeStreamChat(messages, systemPrompt, onToken, opts);
}

/** Convenience: one-shot completion on the fast/cheap model (Haiku). */
export async function llmQuick(prompt: string, systemPrompt = 'You are a helpful assistant.'): Promise<string> {
  return claudeStreamChat([{ role: 'user', content: prompt }], systemPrompt, () => {}, {
    model: FAST_MODEL,
  });
}

/**
 * Vision: send one or more base64 images plus a prompt to Claude. Reads images
 * DIRECTLY — no OCR step — so it's both faster (one call) and more accurate
 * (sees layout, buttons, icons). Used for screen reading.
 */
export async function llmVision(
  images: Array<{ data: string; mediaType?: string }>,
  prompt: string,
  systemPrompt = 'You are JARVIS analyzing a screenshot. Be concise and specific.',
  opts: LLMOptions = {},
): Promise<string> {
  const content: ContentBlock[] = [
    ...images.map((im) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: im.mediaType || 'image/png', data: im.data },
    })),
    { type: 'text' as const, text: prompt },
  ];
  lastUsedLabel = 'Claude (vision)';
  return claudeStreamChat([{ role: 'user', content }], systemPrompt, () => {}, opts);
}

// ── Agentic tool-use loop (Claude Code-style) ──────────────────────────────
//
// Unlike llmStreamChat (text only), this runs a full agentic loop: the model
// can call tools (write files, run bash, …), we execute them and feed the
// results back, and it keeps going until it's done. Used by the `builder`
// module to build whole projects. Designed to work with Fable 5 (thinking is
// always on there — we capture and replay thinking blocks verbatim, which the
// API requires when continuing a tool turn on the same model).

export interface AgentToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
export interface AgentToolResult { content: string; isError?: boolean; }
export interface AgentLoopHandlers {
  system: string;
  runTool: (name: string, input: Record<string, unknown>) => Promise<AgentToolResult>;
  onText?: (t: string) => void;
  onToolStart?: (name: string, input: Record<string, unknown>) => void;
  onToolEnd?: (name: string, preview: string, isError: boolean) => void;
  onStep?: (n: number) => void;
  model?: string;
  maxSteps?: number;
  maxTokens?: number;
}
export interface AgentLoopResult { text: string; steps: number; stopReason: string; model: string; }

type AgentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

interface SSEEvent {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string; data?: string };
  delta?: {
    type?: string; text?: string; thinking?: string; signature?: string;
    partial_json?: string; stop_reason?: string;
  };
  error?: unknown;
}

export async function claudeAgentLoop(
  userPrompt: string,
  tools: AgentToolDef[],
  h: AgentLoopHandlers,
): Promise<AgentLoopResult> {
  if (!config.claudeApiKey) throw new Error('Claude API key not configured.');

  let model = h.model || config.claudeModel || DEFAULT_MODEL;
  const maxSteps = h.maxSteps ?? 40;
  const maxTokens = h.maxTokens ?? 8192;
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
    { role: 'user', content: userPrompt },
  ];
  let fullText = '';
  let triedFallback = false;

  for (let step = 0; step < maxSteps; step++) {
    h.onStep?.(step + 1);

    // Note: no `thinking`/`temperature` params — Fable rejects both (thinking is
    // always on there; other models simply run thinking off, which is fine).
    const body = {
      model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: h.system, cache_control: { type: 'ephemeral' } }],
      tools,
      messages,
      stream: true,
    };

    const response = await undiciFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': config.claudeApiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      dispatcher: keepAliveAgent,
    });

    if (!response.ok) {
      const errText = await response.text();
      // Graceful fallback: if Fable is unavailable (no access / ZDR / other 4xx),
      // drop to Opus 4.8 once and keep the build going.
      if (!triedFallback && model.startsWith('claude-fable') && response.status >= 400 && response.status < 500) {
        triedFallback = true;
        model = 'claude-opus-4-8';
        h.onText?.(`\n[fable unavailable — continuing on opus 4.8]\n`);
        step--;
        continue;
      }
      throw new Error(`Claude API error: ${response.status} ${errText}`);
    }
    if (!response.body) throw new Error('No response body from Claude API');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sse = '';
    const blocks: AgentBlock[] = [];
    const jsonAcc: string[] = [];
    let stopReason = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sse += decoder.decode(value, { stream: true });
        const lines = sse.split('\n');
        sse = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;
          let ev: SSEEvent;
          try { ev = JSON.parse(data) as SSEEvent; } catch { continue; }

          if (ev.type === 'content_block_start') {
            const cb = ev.content_block || {};
            const idx = ev.index ?? blocks.length;
            if (cb.type === 'text') blocks[idx] = { type: 'text', text: '' };
            else if (cb.type === 'thinking') blocks[idx] = { type: 'thinking', thinking: '', signature: '' };
            else if (cb.type === 'redacted_thinking') blocks[idx] = { type: 'redacted_thinking', data: cb.data || '' };
            else if (cb.type === 'tool_use') blocks[idx] = { type: 'tool_use', id: cb.id || '', name: cb.name || '', input: {} };
            jsonAcc[idx] = '';
          } else if (ev.type === 'content_block_delta') {
            const idx = ev.index ?? 0;
            const d = ev.delta || {};
            const b = blocks[idx];
            if (!b) continue;
            if (d.type === 'text_delta' && b.type === 'text') { b.text += d.text || ''; fullText += d.text || ''; h.onText?.(d.text || ''); }
            else if (d.type === 'thinking_delta' && b.type === 'thinking') { b.thinking += d.thinking || ''; }
            else if (d.type === 'signature_delta' && b.type === 'thinking') { b.signature = (b.signature || '') + (d.signature || ''); }
            else if (d.type === 'input_json_delta') { jsonAcc[idx] = (jsonAcc[idx] || '') + (d.partial_json || ''); }
          } else if (ev.type === 'content_block_stop') {
            const idx = ev.index ?? 0;
            const b = blocks[idx];
            if (b && b.type === 'tool_use') {
              try { b.input = JSON.parse(jsonAcc[idx] || '{}') as Record<string, unknown>; } catch { b.input = {}; }
            }
          } else if (ev.type === 'message_delta') {
            if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
          } else if (ev.type === 'error') {
            throw new Error(`Claude stream error: ${JSON.stringify(ev.error || ev)}`);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const assistantContent = blocks.filter(Boolean);
    const toolUses = assistantContent.filter(
      (b): b is Extract<AgentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
    );

    if (stopReason === 'refusal') {
      return { text: fullText || '[The model declined this request.]', steps: step + 1, stopReason, model };
    }

    // Continue whenever the model actually asked for tools — keyed on the blocks
    // themselves, not just stop_reason, so a tool turn is never dropped if the
    // terminating message_delta wasn't observed.
    if (stopReason === 'tool_use' || toolUses.length > 0) {
      // Replay the assistant turn verbatim — thinking blocks (with signatures)
      // included — so the next request is accepted on Fable.
      messages.push({ role: 'assistant', content: assistantContent });
      const results: unknown[] = [];
      for (const tu of toolUses) {
        h.onToolStart?.(tu.name, tu.input);
        let out: AgentToolResult;
        try { out = await h.runTool(tu.name, tu.input); }
        catch (err) { out = { content: `Error: ${(err as Error).message}`, isError: true }; }
        h.onToolEnd?.(tu.name, out.content.slice(0, 200), !!out.isError);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: out.content, is_error: !!out.isError });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }

    // end_turn / stop_sequence / max_tokens (no tools) → finished.
    return { text: fullText, steps: step + 1, stopReason: stopReason || 'end_turn', model };
  }

  return { text: fullText, steps: maxSteps, stopReason: 'max_steps', model };
}

let lastPrewarm = 0;
/**
 * Warm the keep-alive TLS socket to the Claude API. Called on wake-word
 * detection so the connection is hot by the time the user finishes speaking,
 * trimming time-to-first-token. Fire-and-forget, debounced, free (no tokens).
 */
export function prewarmLLM(): void {
  if (!config.claudeApiKey) return;
  const now = Date.now();
  if (now - lastPrewarm < 30_000) return;
  lastPrewarm = now;
  undiciFetch('https://api.anthropic.com/v1/models?limit=1', {
    method: 'GET',
    headers: { 'x-api-key': config.claudeApiKey, 'anthropic-version': '2023-06-01' },
    dispatcher: keepAliveAgent,
  })
    .then((r) => { void r.body?.cancel(); })
    .catch(() => {});
}

export async function isLLMAvailable(): Promise<boolean> {
  return !!config.claudeApiKey;
}

export function getActiveLLMProvider(): string {
  return 'Claude (via API)';
}

export function getLLMConfig(): LLMConfig {
  return { ...config };
}

export function setClaudeApiKey(key: string): void {
  config.claudeApiKey = key;
}

export function setLLMProvider(provider: string): void {
  config.provider = provider;
}

// Friendly aliases -> model IDs for the switcher.
// Fable 5 is the "max brain" option: most capable but 2x Opus / ~3x Sonnet in
// cost, always-on (invisible) thinking, minutes-long turns. Great for one hard
// reasoning question via the pill; a bad default for a snappy voice assistant.
// Keep Sonnet as the default and Haiku for fast work.
export const MODEL_ALIASES: Record<string, string> = {
  fable: 'claude-fable-5', 'fable 5': 'claude-fable-5', 'claude-fable-5': 'claude-fable-5',
  opus: 'claude-opus-4-8', 'opus 4.8': 'claude-opus-4-8', 'claude-opus-4-8': 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6', 'sonnet 4.6': 'claude-sonnet-4-6', 'claude-sonnet-4-6': 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5', 'haiku 4.5': 'claude-haiku-4-5', 'claude-haiku-4-5': 'claude-haiku-4-5',
};

/** Resolve a friendly name (or full id) to a model id, or null if unknown. */
export function resolveModel(name: string): string | null {
  const k = name.trim().toLowerCase();
  return MODEL_ALIASES[k] ?? (k.startsWith('claude-') ? k : null);
}

/** Switch the active conversation model and persist it to config/llm-config.json. */
export function setClaudeModel(model: string): void {
  config.claudeModel = model;
  try { writeJsonConfig('llm-config.json', config); } catch (err) { log.debug('Failed to persist model', err); }
}
