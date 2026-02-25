import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { CommandResult } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface HistoryEntry {
  command: string;
  timestamp: number;
  success: boolean;
}

const MAX_HISTORY = 500;

function getHistoryPath(): string {
  const paths = [
    join(__dirname, '..', '..', 'config', 'history.json'),
    join(__dirname, '..', '..', '..', 'config', 'history.json'),
  ];
  for (const p of paths) {
    const dir = dirname(p);
    if (existsSync(dir)) return p;
  }
  return paths[0];
}

let historyCache: HistoryEntry[] | null = null;

function loadHistory(): HistoryEntry[] {
  if (historyCache) return historyCache;
  const path = getHistoryPath();
  try {
    if (existsSync(path)) {
      historyCache = JSON.parse(readFileSync(path, 'utf-8'));
      return historyCache!;
    }
  } catch { /* ignore */ }
  historyCache = [];
  return historyCache;
}

function saveHistory(): void {
  const path = getHistoryPath();
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
