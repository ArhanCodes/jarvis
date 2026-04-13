// ---------------------------------------------------------------------------
// Undo Stack — Reversible action tracking for JARVIS commands
// ---------------------------------------------------------------------------
// Modules push undo entries after performing reversible actions.
// The user can type "undo" to reverse the last action.

import { createLogger } from '../utils/logger.js';

const log = createLogger('undo');

export interface UndoEntry {
  /** Human-readable description of what was done */
  description: string;
  /** The module that created this entry */
  module: string;
  /** Timestamp of the original action */
  timestamp: number;
  /** Function to reverse the action. Returns true if successful. */
  undo: () => Promise<boolean>;
}

const stack: UndoEntry[] = [];
const MAX_STACK = 50;

/**
 * Push an undoable action onto the stack.
 * Call this from modules after performing a reversible action.
 */
export function pushUndo(entry: Omit<UndoEntry, 'timestamp'>): void {
  stack.push({ ...entry, timestamp: Date.now() });
  if (stack.length > MAX_STACK) {
    stack.shift();
  }
  log.debug(`Pushed undo: ${entry.description}`);
}

/**
 * Pop and execute the most recent undo action.
 * Returns a result message.
 */
export async function popUndo(): Promise<{ success: boolean; message: string }> {
  const entry = stack.pop();
  if (!entry) {
    return { success: false, message: 'Nothing to undo.' };
  }

  try {
    const ok = await entry.undo();
    if (ok) {
      log.info(`Undone: ${entry.description}`);
      return { success: true, message: `Undone: ${entry.description}` };
    } else {
      return { success: false, message: `Undo failed: ${entry.description}` };
    }
  } catch (err) {
    log.error('Undo action threw', err);
    return { success: false, message: `Undo error: ${(err as Error).message}` };
  }
}

/**
 * Peek at the last undoable action without removing it.
 */
export function peekUndo(): UndoEntry | null {
  return stack.length > 0 ? stack[stack.length - 1] : null;
}

/**
 * Get the number of items in the undo stack.
 */
export function undoStackSize(): number {
  return stack.length;
}

/**
 * List recent undoable actions (most recent first).
 */
export function listUndoStack(limit = 10): Array<{ description: string; module: string; age: string }> {
  const now = Date.now();
  return stack
    .slice(-limit)
    .reverse()
    .map((e) => ({
      description: e.description,
      module: e.module,
      age: formatAge(now - e.timestamp),
    }));
}

/**
 * Clear the undo stack.
 */
export function clearUndoStack(): void {
  stack.length = 0;
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}
