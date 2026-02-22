import type { ParsedCommand, ModuleName } from './types.js';
import { registry } from './registry.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const aliasPath = join(__dirname, '..', '..', 'config', 'aliases.json');

function loadAliases(): Record<string, string> {
  try {
    // Try compiled location first, then source location
    const paths = [aliasPath, join(__dirname, '..', '..', '..', 'config', 'aliases.json')];
    for (const p of paths) {
      if (existsSync(p)) {
        return JSON.parse(readFileSync(p, 'utf-8'));
      }
    }
  } catch { /* ignore */ }
  return {};
}

function looksLikePath(text: string): boolean {
  return /[~\/\\]/.test(text) || /\.\w{1,5}$/.test(text);
}

export function parse(raw: string): ParsedCommand | null {
  let input = raw.trim();
  if (!input) return null;

  // Phase 0: Alias expansion
  const aliases = loadAliases();
  const aliasKey = input.toLowerCase();
  if (aliasKey in aliases) {
    input = aliases[aliasKey];
  }

  // Phase 1: Handle "open" disambiguation
  // If input starts with "open" and the target looks like a path, route to file-ops
  const openMatch = input.match(/^open\s+(.+)/i);
  if (openMatch) {
    const target = openMatch[1].trim();
    const isFileOp = /^(folder|directory|dir)\s+/i.test(target) || looksLikePath(target);
    if (isFileOp) {
      // Let file-ops patterns handle it
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

  // Phase 2: Try all registered module patterns
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

  // Phase 3: Keyword fallback
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
  };

  const words = input.toLowerCase().split(/\s+/);
  for (const word of words) {
    if (word in keywordMap) {
      const { module, action } = keywordMap[word];
      return { module, action, args: {}, raw: input, confidence: 0.6 };
    }
  }

  return null;
}
