import { describe, it, expect } from 'vitest';
import { levenshtein, splitChainedCommands } from '../src/core/parser.js';

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('hello', 'hello')).toBe(0);
  });

  it('returns length of other string when one is empty', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('returns 0 for two empty strings', () => {
    expect(levenshtein('', '')).toBe(0);
  });

  it('handles single character difference', () => {
    expect(levenshtein('cat', 'bat')).toBe(1);
    expect(levenshtein('cat', 'car')).toBe(1);
  });

  it('handles insertion', () => {
    expect(levenshtein('cat', 'cats')).toBe(1);
  });

  it('handles deletion', () => {
    expect(levenshtein('cats', 'cat')).toBe(1);
  });

  it('handles multiple edits', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });

  it('is symmetric', () => {
    expect(levenshtein('abc', 'xyz')).toBe(levenshtein('xyz', 'abc'));
  });
});

describe('splitChainedCommands', () => {
  it('returns single command as-is', () => {
    expect(splitChainedCommands('open safari')).toEqual(['open safari']);
  });

  it('splits on &&', () => {
    expect(splitChainedCommands('mute && open safari')).toEqual(['mute', 'open safari']);
  });

  it('splits on ;', () => {
    expect(splitChainedCommands('mute; open safari')).toEqual(['mute', 'open safari']);
  });

  it('splits on mixed && and ;', () => {
    expect(splitChainedCommands('mute && open safari; battery')).toEqual([
      'mute',
      'open safari',
      'battery',
    ]);
  });

  it('preserves quoted strings with && inside', () => {
    expect(splitChainedCommands('say "hello && world"')).toEqual(['say "hello && world"']);
  });

  it('preserves single-quoted strings with ; inside', () => {
    expect(splitChainedCommands("say 'hello; world'")).toEqual(["say 'hello; world'"]);
  });

  it('filters empty segments', () => {
    expect(splitChainedCommands('mute &&  && open safari')).toEqual(['mute', 'open safari']);
  });

  it('trims whitespace', () => {
    expect(splitChainedCommands('  mute  &&  open safari  ')).toEqual(['mute', 'open safari']);
  });

  it('handles empty input', () => {
    expect(splitChainedCommands('')).toEqual([]);
  });
});
