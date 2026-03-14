import { isOllamaRunning, chatStream as ollamaChatStream, OllamaChatMessage } from './ollama.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Hybrid LLM Provider ──
// Abstracts between Claude API and Ollama. Uses Claude by default, falls back to Ollama.
// Benefits: Claude is faster + more accurate; Ollama works offline.

interface LLMConfig {
  provider: 'claude' | 'ollama' | 'auto';
  claudeApiKey?: string;
  ollamaModel?: string;
  claudeModel?: string;
}

let config: LLMConfig = {
  provider: 'auto',
  ollamaModel: 'llama3',
  claudeModel: 'claude-3-5-sonnet-20241022',
};

function loadLLMConfig(): void {
  const paths = [
    join(__dirname, '..', '..', 'config', 'llm-config.json'),
    join(__dirname, '..', '..', '..', 'config', 'llm-config.json'),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const data = JSON.parse(readFileSync(p, 'utf-8')) as LLMConfig;
        config = { ...config, ...data };
        return;
      } catch (e) {
        console.error(`Failed to load LLM config from ${p}:`, e);
      }
    }
  }
}

// Load config on module import
loadLLMConfig();

async function claudeStreamChat(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  systemPrompt: string,
  onToken: (token: string) => void,
): Promise<string> {
  if (!config.claudeApiKey) {
    throw new Error('Claude API key not configured. Set CLAUDE_API_KEY in config/llm-config.json');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.claudeApiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.claudeModel || 'claude-3-5-sonnet-20241022',
      max_tokens: 2048,
      system: systemPrompt,
      messages: messages,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error: ${response.status} ${errText}`);
  }

  if (!response.body) throw new Error('No response body from Claude API');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let sseBuffer = '';  // Buffer for incomplete SSE lines across chunks

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });

      // Process complete lines only — SSE events are separated by \n\n
      const lines = sseBuffer.split('\n');
      // Keep the last (possibly incomplete) line in the buffer
      sseBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data) as {
            type: string;
            delta?: { type: string; text?: string };
          };

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

async function selectProvider(): Promise<'claude' | 'ollama'> {
  if (config.provider === 'claude') return 'claude';
  if (config.provider === 'ollama') return 'ollama';

  // Auto mode: prefer Claude if API key is set, else Ollama
  if (config.claudeApiKey) return 'claude';
  if (await isOllamaRunning()) return 'ollama';

  // Both unavailable, prefer Claude (will error with better message)
  return 'claude';
}

// Track what was actually used in the last call
let lastUsedLabel = '';

export function getLastUsedLabel(): string {
  return lastUsedLabel;
}

export async function llmStreamChat(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  systemPrompt: string,
  onToken: (token: string) => void,
): Promise<string> {
  const provider = await selectProvider();

  if (provider === 'claude') {
    try {
      lastUsedLabel = 'claude';
      return await claudeStreamChat(messages, systemPrompt, onToken);
    } catch (err) {
      // Fallback to Ollama if Claude fails and Ollama is available
      const ollamaUp = await isOllamaRunning();
      if (ollamaUp) {
        lastUsedLabel = `✗ claude → ${config.ollamaModel || 'llama3'}`;
        const ollamaMessages: OllamaChatMessage[] = [
          { role: 'system', content: systemPrompt },
          ...messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        ];
        return ollamaChatStream(config.ollamaModel || 'llama3', ollamaMessages, onToken);
      }
      throw err;
    }
  } else {
    lastUsedLabel = config.ollamaModel || 'llama3';
    // Convert to Ollama format
    const ollamaMessages: OllamaChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ];
    return ollamaChatStream(config.ollamaModel || 'llama3', ollamaMessages, onToken);
  }
}

export async function isLLMAvailable(): Promise<boolean> {
  if (config.claudeApiKey) return true;
  return isOllamaRunning();
}

export function getActiveLLMProvider(): string {
  if (config.provider === 'auto') {
    return config.claudeApiKey ? 'Claude (via API)' : 'Ollama (local)';
  }
  return config.provider === 'claude' ? 'Claude (via API)' : 'Ollama (local)';
}

export function getLLMConfig(): LLMConfig {
  return { ...config };
}

export function setClaudeApiKey(key: string): void {
  config.claudeApiKey = key;
}

export function setLLMProvider(provider: 'claude' | 'ollama' | 'auto'): void {
  config.provider = provider;
}
