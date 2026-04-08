import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { llmStreamChat } from '../utils/llm.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── API Orchestrator Module ──
// Connect to any API autonomously. Register APIs, then call them with natural language.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(__dirname, '..', '..', 'config', 'api-registry.json');

// ── Types ──

interface APIConfig {
  base_url: string;
  headers: Record<string, string>;
  auth_type?: 'bearer' | 'api_key' | 'basic' | 'none';
  schema_summary?: string;
}

type APIRegistry = Record<string, APIConfig>;

// ── Registry Persistence ──

function loadRegistry(): APIRegistry {
  try {
    if (existsSync(REGISTRY_PATH)) {
      return JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8')) as APIRegistry;
    }
  } catch (err) {
    console.error('[api-orchestrator] Failed to load registry:', err);
  }
  return {};
}

function saveRegistry(registry: APIRegistry): void {
  const dir = dirname(REGISTRY_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
}

// ── API Actions ──

async function connectAPI(name: string, baseUrl: string, authType?: string, authValue?: string): Promise<CommandResult> {
  const registry = loadRegistry();

  const config: APIConfig = {
    base_url: baseUrl.replace(/\/+$/, ''),
    headers: { 'Content-Type': 'application/json' },
    auth_type: (authType as APIConfig['auth_type']) || 'none',
  };

  // Set auth headers based on type
  if (authType === 'bearer' && authValue) {
    config.headers['Authorization'] = `Bearer ${authValue}`;
  } else if (authType === 'api_key' && authValue) {
    config.headers['X-API-Key'] = authValue;
  } else if (authType === 'basic' && authValue) {
    const encoded = Buffer.from(authValue).toString('base64');
    config.headers['Authorization'] = `Basic ${encoded}`;
  }

  // Try to fetch OpenAPI spec
  try {
    const specUrl = `${config.base_url}/openapi.json`;
    const resp = await fetch(specUrl, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const spec = await resp.json() as { info?: { title?: string; description?: string }; paths?: Record<string, unknown> };
      const paths = spec.paths ? Object.keys(spec.paths).slice(0, 20) : [];
      config.schema_summary = [
        spec.info?.title || name,
        spec.info?.description || '',
        `Endpoints: ${paths.join(', ')}`,
      ].join(' | ');
    }
  } catch {
    // No OpenAPI spec available — that's fine
  }

  registry[name.toLowerCase()] = config;
  saveRegistry(registry);

  return {
    success: true,
    message: `Connected API "${name}" at ${config.base_url}${config.schema_summary ? ' (OpenAPI spec loaded)' : ''}.`,
  };
}

async function callAPI(apiName: string, request: string): Promise<CommandResult> {
  const registry = loadRegistry();
  const key = apiName.toLowerCase();
  const config = registry[key];

  if (!config) {
    const available = Object.keys(registry);
    return {
      success: false,
      message: `API "${apiName}" not found. ${available.length > 0 ? `Available: ${available.join(', ')}` : 'No APIs registered. Use "connect to <name> api at <url>" first.'}`,
    };
  }

  // Use LLM to generate the fetch call spec
  const systemPrompt = `You are an API call generator. Given a user request and API configuration, generate the exact HTTP call to make.

API: ${key}
Base URL: ${config.base_url}
${config.schema_summary ? `Schema: ${config.schema_summary}` : ''}

Respond with ONLY a JSON object (no markdown fences):
{
  "url": "full URL including base",
  "method": "GET|POST|PUT|DELETE|PATCH",
  "headers": {},
  "body": null
}

Rules:
- url must start with the base URL: ${config.base_url}
- Use appropriate REST conventions (GET for reads, POST for creates, etc.)
- Include query parameters in the URL when appropriate
- body should be null for GET/DELETE, or a JSON object for POST/PUT/PATCH
- headers should only include Content-Type if sending a body; auth headers are added automatically
- Respond ONLY with the JSON object`;

  let fetchSpec: { url: string; method: string; headers: Record<string, string>; body: unknown };

  try {
    const llmResponse = await llmStreamChat(
      [{ role: 'user', content: `Generate API call for: "${request}"` }],
      systemPrompt,
      () => {},
    );

    let cleaned = llmResponse.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    fetchSpec = JSON.parse(cleaned) as typeof fetchSpec;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Failed to generate API call: ${errMsg}` };
  }

  // Merge auth headers from config
  const mergedHeaders = { ...config.headers, ...fetchSpec.headers };

  // Execute the fetch
  try {
    const fetchOpts: RequestInit = {
      method: fetchSpec.method || 'GET',
      headers: mergedHeaders,
      signal: AbortSignal.timeout(30000),
    };

    if (fetchSpec.body && !['GET', 'HEAD', 'DELETE'].includes(fetchSpec.method.toUpperCase())) {
      fetchOpts.body = typeof fetchSpec.body === 'string' ? fetchSpec.body : JSON.stringify(fetchSpec.body);
    }

    const response = await fetch(fetchSpec.url, fetchOpts);
    const contentType = response.headers.get('content-type') || '';

    let responseBody: unknown;
    if (contentType.includes('application/json')) {
      responseBody = await response.json();
    } else {
      responseBody = await response.text();
    }

    if (!response.ok) {
      return {
        success: false,
        message: `API returned ${response.status} ${response.statusText}: ${typeof responseBody === 'string' ? responseBody.slice(0, 500) : JSON.stringify(responseBody).slice(0, 500)}`,
        data: { status: response.status, body: responseBody },
      };
    }

    const bodyStr = typeof responseBody === 'string'
      ? responseBody.slice(0, 2000)
      : JSON.stringify(responseBody, null, 2).slice(0, 2000);

    return {
      success: true,
      message: `${fetchSpec.method} ${fetchSpec.url} -> ${response.status}\n\n${bodyStr}`,
      data: { status: response.status, body: responseBody },
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `API call failed: ${errMsg}` };
  }
}

function listAPIs(): CommandResult {
  const registry = loadRegistry();
  const keys = Object.keys(registry);

  if (keys.length === 0) {
    return { success: true, message: 'No APIs registered. Use "connect to <name> api at <url>" to add one.' };
  }

  const lines = keys.map(name => {
    const cfg = registry[name];
    const auth = cfg.auth_type && cfg.auth_type !== 'none' ? ` (${cfg.auth_type})` : '';
    const schema = cfg.schema_summary ? ' [schema loaded]' : '';
    return `  ${name}: ${cfg.base_url}${auth}${schema}`;
  });

  return {
    success: true,
    message: `Registered APIs (${keys.length}):\n${lines.join('\n')}`,
    data: { apis: keys },
  };
}

function removeAPI(name: string): CommandResult {
  const registry = loadRegistry();
  const key = name.toLowerCase();

  if (!registry[key]) {
    return { success: false, message: `API "${name}" not found.` };
  }

  delete registry[key];
  saveRegistry(registry);

  return { success: true, message: `Removed API "${name}".` };
}

// ── Module Definition ──

const apiOrchestratorModule: JarvisModule = {
  name: 'api-orchestrator',
  description: 'Connect to and call any API using natural language',

  patterns: [
    {
      intent: 'connect',
      patterns: [
        /^connect\s+(?:to\s+)?(\w+)\s+api\s+(?:at\s+)?(.+)/i,
        /^register\s+(?:the\s+)?(\w+)\s+api\s+(?:at\s+)?(.+)/i,
        /^add\s+(?:the\s+)?(\w+)\s+api\s+(?:at\s+)?(.+)/i,
      ],
      extract: (match, _raw) => ({
        name: match[1],
        url: match[2].trim(),
      }),
    },
    {
      intent: 'call',
      patterns: [
        /^call\s+(\w+)\s+api\s+(?:to\s+)?(.+)/i,
        /^api\s+(\w+)\s+(.+)/i,
        /^(?:use|query|hit)\s+(\w+)\s+api\s+(?:to\s+)?(.+)/i,
      ],
      extract: (match, _raw) => ({
        name: match[1],
        request: match[2].trim(),
      }),
    },
    {
      intent: 'list',
      patterns: [
        /^list\s+apis?/i,
        /^show\s+(?:registered\s+)?apis?/i,
        /^(?:my\s+)?apis?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'remove',
      patterns: [
        /^remove\s+(\w+)\s+api/i,
        /^delete\s+(\w+)\s+api/i,
        /^disconnect\s+(\w+)\s+api/i,
      ],
      extract: (match, _raw) => ({ name: match[1] }),
    },
  ] as PatternDefinition[],

  async execute(command: ParsedCommand): Promise<CommandResult> {
    const { action, args } = command;

    try {
      switch (action) {
        case 'connect': {
          const name = args.name;
          const url = args.url;
          if (!name || !url) {
            return { success: false, message: 'Usage: connect to <name> api at <base_url>' };
          }
          // Parse optional auth from URL string: "https://api.example.com bearer sk-123"
          const urlParts = url.split(/\s+/);
          const baseUrl = urlParts[0];
          const authType = urlParts[1];
          const authValue = urlParts.slice(2).join(' ');
          return await connectAPI(name, baseUrl, authType, authValue);
        }

        case 'call': {
          const apiName = args.name;
          const request = args.request;
          if (!apiName || !request) {
            return { success: false, message: 'Usage: call <api_name> api to <request>' };
          }
          return await callAPI(apiName, request);
        }

        case 'list':
          return listAPIs();

        case 'remove': {
          const name = args.name;
          if (!name) {
            return { success: false, message: 'Usage: remove <api_name> api' };
          }
          return removeAPI(name);
        }

        default:
          return { success: false, message: `Unknown api-orchestrator action: ${action}` };
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `API orchestrator error: ${errMsg}` };
    }
  },

  getHelp(): string {
    return [
      'API Orchestrator — Connect to and call any API with natural language',
      '',
      'Usage:',
      '  "connect to github api at https://api.github.com bearer ghp_xxx"',
      '  "call github api to list my repositories"',
      '  "list apis"',
      '  "remove github api"',
      '',
      'Auth types: bearer <token>, api_key <key>, basic <user:pass>',
    ].join('\n');
  },
};

export default apiOrchestratorModule;
