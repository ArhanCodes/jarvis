import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── Persistent Memory System ──
// Stores user facts, preferences, and conversation history across sessions.
// Two files: config/memory.json (facts) and config/conversations.json (history).

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveConfigPath(filename: string): string {
  // Walk up from __dirname to find the project root config/ directory.
  // The project root config/ contains memory.json, conversations.json, etc.
  // We must skip dist/config/ which is a build artifact.
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'config', filename);
    const configDir = join(dir, 'config');
    // Skip if we're inside the dist directory
    if (existsSync(join(dir, 'package.json')) && existsSync(configDir) && !dir.includes('/dist')) {
      return candidate;
    }
    // Also check if config exists at this level and package.json is one level up
    if (existsSync(configDir) && !dir.includes('/dist') && existsSync(join(dir, '..', 'package.json'))) {
      return candidate;
    }
    dir = join(dir, '..');
  }
  // Fallback: go up until we find package.json (project root)
  dir = __dirname;
  for (let i = 0; i < 6; i++) {
    dir = join(dir, '..');
    if (existsSync(join(dir, 'package.json'))) {
      const configDir = join(dir, 'config');
      if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
      return join(configDir, filename);
    }
  }
  // Last resort
  const configDir = join(__dirname, '..', '..', 'config');
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  return join(configDir, filename);
}

// ── Types ──

export interface MemoryFact {
  key: string;
  value: string;
  source: string;
  category: 'fact' | 'preference' | 'contact' | 'habit';
  createdAt: number;
  updatedAt: number;
}

export interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  commandExecuted?: string;
}

export interface ConversationSummary {
  summary: string;
  coveredRange: [number, number];
  createdAt: number;
}

interface MemoryFile {
  version: number;
  facts: MemoryFact[];
}

interface ConversationsFile {
  conversations: ConversationEntry[];
  summaries: ConversationSummary[];
}

// ── State ──

let memoryData: MemoryFile = { version: 1, facts: [] };
let conversationData: ConversationsFile = { conversations: [], summaries: [] };
let memoryDirty = 0;
let conversationDirty = 0;
const WRITE_INTERVAL = 5; // write every N changes
let loaded = false;

// ── Load / Save ──

function getMemoryPath(): string {
  return resolveConfigPath('memory.json');
}

function getConversationsPath(): string {
  return resolveConfigPath('conversations.json');
}

export function loadMemory(): void {
  if (loaded) return;
  loaded = true;

  // Load facts
  const memPath = getMemoryPath();
  if (existsSync(memPath)) {
    try {
      memoryData = JSON.parse(readFileSync(memPath, 'utf-8'));
    } catch {
      memoryData = { version: 1, facts: [] };
    }
  } else {
    // Pre-seed with user name
    memoryData = {
      version: 1,
      facts: [
        {
          key: 'user.name',
          value: 'Arhan',
          source: 'initial setup',
          category: 'fact',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    };
    saveMemoryNow();
  }

  // Load conversations
  const convPath = getConversationsPath();
  if (existsSync(convPath)) {
    try {
      conversationData = JSON.parse(readFileSync(convPath, 'utf-8'));
    } catch {
      conversationData = { conversations: [], summaries: [] };
    }
  }
}

function saveMemoryNow(): void {
  try {
    writeFileSync(getMemoryPath(), JSON.stringify(memoryData, null, 2), 'utf-8');
  } catch { /* ignore */ }
}

function saveConversationsNow(): void {
  try {
    writeFileSync(getConversationsPath(), JSON.stringify(conversationData, null, 2), 'utf-8');
  } catch { /* ignore */ }
}

function maybeSaveMemory(): void {
  memoryDirty++;
  if (memoryDirty >= WRITE_INTERVAL) {
    memoryDirty = 0;
    saveMemoryNow();
  }
}

function maybeSaveConversations(): void {
  conversationDirty++;
  if (conversationDirty >= WRITE_INTERVAL) {
    conversationDirty = 0;
    saveConversationsNow();
  }
}

// ── Facts CRUD ──

export function addFact(
  key: string,
  value: string,
  source: string,
  category: MemoryFact['category'],
): void {
  loadMemory();
  const existing = memoryData.facts.find(f => f.key === key);
  if (existing) {
    existing.value = value;
    existing.source = source;
    existing.category = category;
    existing.updatedAt = Date.now();
  } else {
    memoryData.facts.push({
      key,
      value,
      source,
      category,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  maybeSaveMemory();
}

export function getFact(key: string): MemoryFact | undefined {
  loadMemory();
  return memoryData.facts.find(f => f.key === key);
}

export function searchFacts(query: string): MemoryFact[] {
  loadMemory();
  const q = query.toLowerCase();
  return memoryData.facts.filter(
    f => f.key.toLowerCase().includes(q) ||
         f.value.toLowerCase().includes(q) ||
         f.source.toLowerCase().includes(q),
  );
}

export function getAllFacts(): MemoryFact[] {
  loadMemory();
  return [...memoryData.facts];
}

export function removeFact(key: string): boolean {
  loadMemory();
  const idx = memoryData.facts.findIndex(f => f.key === key);
  if (idx === -1) return false;
  memoryData.facts.splice(idx, 1);
  maybeSaveMemory();
  return true;
}

// ── Conversation History ──

export function addConversationEntry(entry: Omit<ConversationEntry, 'timestamp'>): void {
  loadMemory();
  conversationData.conversations.push({
    ...entry,
    timestamp: Date.now(),
  });
  maybeSaveConversations();
}

export function getRecentConversation(count = 30): ConversationEntry[] {
  loadMemory();
  return conversationData.conversations.slice(-count);
}

export function getAllConversations(): ConversationEntry[] {
  loadMemory();
  return [...conversationData.conversations];
}

export function clearConversation(): void {
  loadMemory();
  conversationData.conversations = [];
  saveConversationsNow();
}

export function setConversations(entries: ConversationEntry[]): void {
  loadMemory();
  conversationData.conversations = entries;
  saveConversationsNow();
}

// ── Summaries ──

export function addSummary(summary: string, range: [number, number]): void {
  loadMemory();
  conversationData.summaries.push({
    summary,
    coveredRange: range,
    createdAt: Date.now(),
  });

  // Cap at 20 summaries
  if (conversationData.summaries.length > 20) {
    // Consolidate oldest 10 into one
    const oldest = conversationData.summaries.splice(0, 10);
    const merged = oldest.map(s => s.summary).join(' ');
    conversationData.summaries.unshift({
      summary: merged,
      coveredRange: [oldest[0].coveredRange[0], oldest[oldest.length - 1].coveredRange[1]],
      createdAt: Date.now(),
    });
  }
  saveConversationsNow();
}

export function getSummaries(): ConversationSummary[] {
  loadMemory();
  return [...conversationData.summaries];
}

// ── Context Building ──

export function buildMemoryContext(): string {
  loadMemory();
  const parts: string[] = [];

  // Facts
  if (memoryData.facts.length > 0) {
    parts.push('[MEMORY - What I know about the user (USE THIS TO ANSWER QUESTIONS)]');
    for (const f of memoryData.facts) {
      // Format with both the key and a human-readable description
      const readableKey = f.key.replace(/\./g, ' ').replace(/_/g, ' ');
      parts.push(`- ${readableKey}: ${f.value} (stored as: ${f.key})`);
    }
  }

  // Summaries
  if (conversationData.summaries.length > 0) {
    parts.push('');
    parts.push('[MEMORY - Previous conversations]');
    for (const s of conversationData.summaries.slice(-5)) {
      parts.push(`- ${s.summary}`);
    }
  }

  return parts.join('\n');
}

// ── Flush ──

export function flushMemory(): void {
  if (memoryDirty > 0) {
    memoryDirty = 0;
    saveMemoryNow();
  }
  if (conversationDirty > 0) {
    conversationDirty = 0;
    saveConversationsNow();
  }
}
