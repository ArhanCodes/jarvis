import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { CommandResult } from './types.js';
import { configPath } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('history');

interface HistoryEntry {
  command: string;
  timestamp: number;
  success: boolean;
}

const MAX_HISTORY = 500;

let historyCache: HistoryEntry[] | null = null;

function loadHistory(): HistoryEntry[] {
  if (historyCache) return historyCache;
  const path = configPath('history.json');
  try {
    if (existsSync(path)) {
      historyCache = JSON.parse(readFileSync(path, 'utf-8'));
      return historyCache!;
    }
  } catch (err) { log.warn('Failed to load history', err); }
  historyCache = [];
  return historyCache;
}

function saveHistory(): void {
  const path = configPath('history.json');
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const history = loadHistory();
  writeFileSync(path, JSON.stringify(history.slice(-MAX_HISTORY), null, 2) + '\n');
}

export function recordCommand(command: string, result: CommandResult): void {
  const history = loadHistory();
  history.push({
    command,
    timestamp: Date.now(),
    success: result.success,
  });
  // Only save every 5 commands to reduce I/O
  if (history.length % 5 === 0) {
    saveHistory();
  }
}

export function getHistory(count: number = 20): HistoryEntry[] {
  const history = loadHistory();
  return history.slice(-count);
}

export function searchHistory(query: string): HistoryEntry[] {
  const lower = query.toLowerCase();
  return loadHistory().filter(e => e.command.toLowerCase().includes(lower)).slice(-20);
}

export function getLastCommand(): string | null {
  const history = loadHistory();
  return history.length > 0 ? history[history.length - 1].command : null;
}

export function flushHistory(): void {
  saveHistory();
}

export function clearHistory(): void {
  historyCache = [];
  saveHistory();
}
