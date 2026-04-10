import type { ParsedCommand, ModuleName } from './types.js';
import { registry } from './registry.js';
import { expandVariables } from './context.js';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fuzzyMatch as rustFuzzyMatch, isSidecarAvailable, type KeywordEntry } from '../utils/rust-bridge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Alias loading (cached) ──
let aliasCache: Record<string, string> | null = null;
let aliasMtime = 0;

function loadAliases(): Record<string, string> {
  const paths = [
    join(__dirname, '..', '..', 'config', 'aliases.json'),
    join(__dirname, '..', '..', '..', 'config', 'aliases.json'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const stat = statSync(p);
        if (stat.mtimeMs !== aliasMtime) {
          aliasMtime = stat.mtimeMs;
          aliasCache = JSON.parse(readFileSync(p, 'utf-8'));
        }
        return aliasCache ?? {};
      } catch { /* ignore */ }
    }
  }
  return {};
}

export function invalidateAliasCache(): void {
  aliasCache = null;
  aliasMtime = 0;
}

function looksLikePath(text: string): boolean {
  return /[~\/\\]/.test(text) || /\.\w{1,5}$/.test(text);
}

// ── Levenshtein distance for typo tolerance ──
export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ── Command chaining: split on && and ; ──
export function splitChainedCommands(input: string): string[] {
  // Split on && or ; but not inside quotes
  const parts: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'" && !inDoubleQuote) { inSingleQuote = !inSingleQuote; current += ch; continue; }
    if (ch === '"' && !inSingleQuote) { inDoubleQuote = !inDoubleQuote; current += ch; continue; }

    if (!inSingleQuote && !inDoubleQuote) {
      if (ch === '&' && input[i + 1] === '&') {
        parts.push(current.trim());
        current = '';
        i++; // skip second &
        continue;
      }
      if (ch === ';') {
        parts.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

export async function parse(raw: string): Promise<ParsedCommand | null> {
  let input = raw.trim();
  if (!input) return null;

  // Phase 0: Variable expansion
  input = expandVariables(input);

  // Phase 1: Alias expansion
  const aliases = loadAliases();
  const aliasKey = input.toLowerCase();
  if (aliasKey in aliases) {
    input = aliases[aliasKey];
  }

  // Phase 2: Handle "open" disambiguation
  const openMatch = input.match(/^open\s+(.+)/i);
  if (openMatch) {
    const target = openMatch[1].trim();
    const isFileOp = /^(folder|directory|dir)\s+/i.test(target) || looksLikePath(target);
    if (isFileOp) {
      const fileOpsPatterns = registry.getAllPatterns().filter(p => p.module === 'file-ops');
      for (const { module, pattern: patternDef } of fileOpsPatterns) {
        for (const regex of patternDef.patterns) {
          const match = input.match(regex);
          if (match) {
            return {
              module, action: patternDef.intent,
              args: patternDef.extract(match, input),
              raw: input, confidence: 1.0,
            };
          }
        }
      }
    }
  }

  // Phase 3: Try all registered module patterns (exact regex match)
  for (const { module, pattern: patternDef } of registry.getAllPatterns()) {
    for (const regex of patternDef.patterns) {
      const match = input.match(regex);
      if (match) {
        return {
          module, action: patternDef.intent,
          args: patternDef.extract(match, input),
          raw: input, confidence: 1.0,
        };
      }
    }
  }

  // Phase 4: Keyword fallback (single-word exact match)
  const keywordMap: Record<string, { module: ModuleName; action: string }> = {
    battery: { module: 'system-monitor', action: 'battery' },
    cpu: { module: 'system-monitor', action: 'cpu' },
    processor: { module: 'system-monitor', action: 'cpu' },
    memory: { module: 'system-monitor', action: 'memory' },
    ram: { module: 'system-monitor', action: 'memory' },
    disk: { module: 'system-monitor', action: 'disk' },
    storage: { module: 'system-monitor', action: 'disk' },
    network: { module: 'system-monitor', action: 'network' },
    wifi: { module: 'system-monitor', action: 'network' },
    ip: { module: 'system-monitor', action: 'network' },
    mute: { module: 'system-control', action: 'mute' },
    unmute: { module: 'system-control', action: 'unmute' },
    louder: { module: 'system-control', action: 'volume-up' },
    quieter: { module: 'system-control', action: 'volume-down' },
    brighter: { module: 'system-control', action: 'brightness-up' },
    dimmer: { module: 'system-control', action: 'brightness-down' },
    screensaver: { module: 'system-control', action: 'screensaver' },
    stopwatch: { module: 'timer', action: 'stopwatch-start' },
    timers: { module: 'timer', action: 'list-timers' },
    clips: { module: 'clipboard', action: 'clip-history' },
    clipboard: { module: 'clipboard', action: 'paste' },
    paste: { module: 'clipboard', action: 'paste' },
    windows: { module: 'window-manager', action: 'list-windows' },
    workflows: { module: 'workflow', action: 'list-workflows' },
    shortcuts: { module: 'workflow', action: 'list-shortcuts' },
    scheduled: { module: 'scheduler', action: 'list-tasks' },
    cron: { module: 'scheduler', action: 'list-tasks' },
    ps: { module: 'process-manager', action: 'list-processes' },
    models: { module: 'ai-chat', action: 'ai-status' },
    ai: { module: 'ai-chat', action: 'ai-status' },
    jarvis: { module: 'personality', action: 'identity' },
    joke: { module: 'personality', action: 'joke' },
    suggestions: { module: 'smart-assist', action: 'what-can-i-do' },
    weather: { module: 'weather-news', action: 'weather' },
    forecast: { module: 'weather-news', action: 'forecast' },
    news: { module: 'weather-news', action: 'news' },
    headlines: { module: 'weather-news', action: 'news' },
    routines: { module: 'smart-routines', action: 'list-routines' },
    ocr: { module: 'screen-awareness', action: 'read-screen' },
    convert: { module: 'conversions', action: 'unit' },
    conversion: { module: 'conversions', action: 'unit' },
  };

  const words = input.toLowerCase().split(/\s+/);
  for (const word of words) {
    if (word in keywordMap) {
      const { module, action } = keywordMap[word];
      return { module, action, args: {}, raw: input, confidence: 0.6 };
    }
  }

  // Phase 5: Fuzzy keyword match (typo tolerance, distance <= 2)
  // Try Rust sidecar first for faster Levenshtein, fall back to JS
  if (words.length <= 3) {
    const rustResult = await tryRustFuzzyMatch(input, keywordMap);
    if (rustResult) return rustResult;

    // JS fallback
    const allKeywords = Object.keys(keywordMap);
    for (const word of words) {
      if (word.length < 3) continue;
      for (const keyword of allKeywords) {
        const dist = levenshtein(word, keyword);
        if (dist <= 2 && dist < word.length * 0.4) {
          const { module, action } = keywordMap[word in keywordMap ? word : keyword];
          return { module, action, args: {}, raw: input, confidence: 0.4 };
        }
      }
    }
  }

  return null;
}

async function tryRustFuzzyMatch(
  input: string,
  keywordMap: Record<string, { module: ModuleName; action: string }>,
): Promise<ParsedCommand | null> {
  try {
    if (!(await isSidecarAvailable())) return null;

    const keywords: KeywordEntry[] = Object.entries(keywordMap).map(
      ([keyword, { module, action }]) => ({ keyword, module, action }),
    );

    const match = await rustFuzzyMatch(input, keywords, 2);
    if (match) {
      return {
        module: match.module as ModuleName,
        action: match.action,
        args: {},
        raw: input,
        confidence: match.confidence * 0.5,
      };
    }
  } catch {
    // Fall through to JS implementation
  }
  return null;
}
