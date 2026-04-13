import { readJsonConfig } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('llm');

// ── LLM Provider (Claude API) ──

interface LLMConfig {
  provider: string;
  claudeApiKey?: string;
  claudeModel?: string;
}

let config: LLMConfig = {
  provider: 'claude',
  claudeModel: 'claude-3-5-sonnet-20241022',
};

function loadLLMConfig(): void {
  const data = readJsonConfig<LLMConfig>('llm-config.json', {} as LLMConfig);
  config = { ...config, ...data };
}

// Load config on module import
loadLLMConfig();

async function claudeStreamChat(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  systemPrompt: string,
  onToken: (token: string) => void,
): Promise<string> {
  if (!config.claudeApiKey) {
    throw new Error('Claude API key not configured. Set claudeApiKey in config/llm-config.json');
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
      max_tokens: 4096,
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

let lastUsedLabel = '';

export function getLastUsedLabel(): string {
  return lastUsedLabel;
}

export async function llmStreamChat(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  systemPrompt: string,
  onToken: (token: string) => void,
): Promise<string> {
  lastUsedLabel = 'Claude (via API)';
  return claudeStreamChat(messages, systemPrompt, onToken);
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
