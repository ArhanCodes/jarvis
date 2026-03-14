const OLLAMA_BASE = 'http://localhost:11434';

export interface OllamaModel {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
}

interface OllamaTagsResponse {
  models: OllamaModel[];
}

interface OllamaGenerateChunk {
  model: string;
  response: string;
  done: boolean;
  total_duration?: number;
  eval_count?: number;
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChatChunk {
  message: { role: string; content: string };
  done: boolean;
}

export async function isOllamaRunning(): Promise<boolean> {
  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function listModels(): Promise<OllamaModel[]> {
  const resp = await fetch(`${OLLAMA_BASE}/api/tags`);
  if (!resp.ok) throw new Error(`Ollama API error: ${resp.status}`);
  const data = (await resp.json()) as OllamaTagsResponse;
  return data.models ?? [];
}

export async function generate(model: string, prompt: string): Promise<string> {
  const resp = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
  });
  if (!resp.ok) throw new Error(`Ollama error: ${resp.status} ${resp.statusText}`);
  const data = (await resp.json()) as OllamaGenerateChunk;
  return data.response;
}

export async function generateStream(
  model: string,
  prompt: string,
  onToken: (token: string) => void,
): Promise<string> {
  const resp = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: true }),
  });
  if (!resp.ok) throw new Error(`Ollama error: ${resp.status} ${resp.statusText}`);
  return readStream(resp, (chunk: string) => {
    try {
      const parsed = JSON.parse(chunk) as OllamaGenerateChunk;
      onToken(parsed.response);
      return { text: parsed.response, done: parsed.done };
    } catch {
      return { text: '', done: false };
    }
  });
}

export interface OllamaStreamOptions {
  signal?: AbortSignal;
  num_predict?: number;
  temperature?: number;
  num_ctx?: number;
}

export async function chatStream(
  model: string,
  messages: OllamaChatMessage[],
  onToken: (token: string) => void,
  streamOptions?: OllamaStreamOptions,
): Promise<string> {
  const body: Record<string, unknown> = { model, messages, stream: true };
  const opts: Record<string, unknown> = {};
  if (streamOptions?.num_predict) opts.num_predict = streamOptions.num_predict;
  if (streamOptions?.temperature !== undefined) opts.temperature = streamOptions.temperature;
  if (streamOptions?.num_ctx) opts.num_ctx = streamOptions.num_ctx;
  if (Object.keys(opts).length > 0) body.options = opts;

  const resp = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: streamOptions?.signal,
  });
  if (!resp.ok) throw new Error(`Ollama error: ${resp.status} ${resp.statusText}`);
  return readStream(resp, (chunk: string) => {
    try {
      const parsed = JSON.parse(chunk) as OllamaChatChunk;
      onToken(parsed.message.content);
      return { text: parsed.message.content, done: parsed.done };
    } catch {
      return { text: '', done: false };
    }
  });
}

async function readStream(
  resp: Response,
  parseChunk: (line: string) => { text: string; done: boolean },
): Promise<string> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let fullResponse = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      const result = parseChunk(line);
      fullResponse += result.text;
      if (result.done) return fullResponse;
    }
  }

  // Process any remaining buffer
  if (buffer.trim()) {
    const result = parseChunk(buffer);
    fullResponse += result.text;
  }

  return fullResponse;
}
