import { describe, it, expect, beforeEach } from 'vitest';
import {
  pushUndo,
  popUndo,
  peekUndo,
  undoStackSize,
  listUndoStack,
  clearUndoStack,
} from '../src/core/undo-stack.js';

describe('undo-stack', () => {
  beforeEach(() => {
    clearUndoStack();
  });

  it('starts empty', () => {
    expect(undoStackSize()).toBe(0);
    expect(peekUndo()).toBeNull();
  });

  it('pushUndo adds an entry', () => {
    pushUndo({
      description: 'Set volume to 80',
      module: 'system-control',
      undo: async () => true,
    });
    expect(undoStackSize()).toBe(1);
  });

  it('peekUndo returns last entry without removing it', () => {
    pushUndo({
      description: 'Opened Safari',
      module: 'app-launcher',
      undo: async () => true,
    });
    const entry = peekUndo();
    expect(entry?.description).toBe('Opened Safari');
    expect(undoStackSize()).toBe(1); // still there
  });

  it('popUndo executes the undo function', async () => {
    let undone = false;
    pushUndo({
      description: 'Muted volume',
      module: 'system-control',
      undo: async () => {
        undone = true;
        return true;
      },
    });

    const result = await popUndo();
    expect(result.success).toBe(true);
    expect(result.message).toContain('Muted volume');
    expect(undone).toBe(true);
    expect(undoStackSize()).toBe(0);
  });

  it('popUndo returns failure message on empty stack', async () => {
    const result = await popUndo();
    expect(result.success).toBe(false);
    expect(result.message).toBe('Nothing to undo.');
  });

  it('popUndo handles failed undo', async () => {
    pushUndo({
      description: 'Something',
      module: 'test',
      undo: async () => false,
    });
    const result = await popUndo();
    expect(result.success).toBe(false);
    expect(result.message).toContain('Undo failed');
  });

  it('popUndo handles thrown error', async () => {
    pushUndo({
      description: 'Risky op',
      module: 'test',
      undo: async () => {
        throw new Error('kaboom');
      },
    });
    const result = await popUndo();
    expect(result.success).toBe(false);
    expect(result.message).toContain('kaboom');
  });

  it('LIFO order', async () => {
    pushUndo({ description: 'first', module: 'a', undo: async () => true });
    pushUndo({ description: 'second', module: 'b', undo: async () => true });
    pushUndo({ description: 'third', module: 'c', undo: async () => true });

    const r1 = await popUndo();
    expect(r1.message).toContain('third');
    const r2 = await popUndo();
    expect(r2.message).toContain('second');
    const r3 = await popUndo();
    expect(r3.message).toContain('first');
  });

  it('listUndoStack returns entries most-recent-first', () => {
    pushUndo({ description: 'first', module: 'a', undo: async () => true });
    pushUndo({ description: 'second', module: 'b', undo: async () => true });

    const list = listUndoStack();
    expect(list.length).toBe(2);
    expect(list[0].description).toBe('second');
    expect(list[1].description).toBe('first');
    expect(list[0].age).toMatch(/\ds ago/);
  });

  it('clearUndoStack empties the stack', () => {
    pushUndo({ description: 'x', module: 'a', undo: async () => true });
    pushUndo({ description: 'y', module: 'b', undo: async () => true });
    clearUndoStack();
    expect(undoStackSize()).toBe(0);
  });

  it('respects max stack size (50)', () => {
    for (let i = 0; i < 60; i++) {
      pushUndo({ description: `action ${i}`, module: 'test', undo: async () => true });
    }
    expect(undoStackSize()).toBe(50);
  });
});
