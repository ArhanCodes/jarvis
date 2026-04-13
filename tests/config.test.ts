import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

// We test the config module functions by importing them.
// Since getProjectRoot() uses process.cwd(), and our test runs from the project root,
// it should resolve correctly.
import {
  getProjectRoot,
  configPath,
  projectPath,
  readJsonConfig,
  writeJsonConfig,
  readCachedConfig,
  invalidateCache,
} from '../src/utils/config.js';

describe('getProjectRoot', () => {
  it('returns a directory containing package.json', () => {
    const root = getProjectRoot();
    expect(existsSync(join(root, 'package.json'))).toBe(true);
  });

  it('returns a directory containing config/', () => {
    const root = getProjectRoot();
    expect(existsSync(join(root, 'config'))).toBe(true);
  });
});

describe('configPath', () => {
  it('returns a path under the config directory', () => {
    const p = configPath('test-file.json');
    expect(p).toContain('/config/test-file.json');
  });

  it('returns an absolute path', () => {
    const p = configPath('test-file.json');
    expect(p.startsWith('/')).toBe(true);
  });
});

describe('projectPath', () => {
  it('joins segments onto the project root', () => {
    const p = projectPath('src', 'index.ts');
    expect(p).toContain('/src/index.ts');
    expect(existsSync(p)).toBe(true);
  });
});

describe('readJsonConfig / writeJsonConfig', () => {
  const testFile = '_test_config_rw.json';

  afterEach(() => {
    const p = configPath(testFile);
    if (existsSync(p)) rmSync(p);
  });

  it('returns fallback when file does not exist', () => {
    const result = readJsonConfig('_nonexistent_test.json', { x: 42 });
    expect(result).toEqual({ x: 42 });
  });

  it('writes and reads back JSON data', () => {
    const data = { name: 'jarvis', version: 1, items: ['a', 'b'] };
    writeJsonConfig(testFile, data);
    const result = readJsonConfig(testFile, {});
    expect(result).toEqual(data);
  });

  it('returns fallback for corrupted JSON', () => {
    const p = configPath(testFile);
    writeFileSync(p, '{invalid json!!!', 'utf-8');
    const result = readJsonConfig(testFile, { fallback: true });
    expect(result).toEqual({ fallback: true });
  });
});

describe('readCachedConfig', () => {
  const testFile = '_test_cached.json';

  afterEach(() => {
    invalidateCache(testFile);
    const p = configPath(testFile);
    if (existsSync(p)) rmSync(p);
  });

  it('caches reads and returns same object on repeated calls', () => {
    writeJsonConfig(testFile, { cached: true });
    const first = readCachedConfig(testFile, {});
    const second = readCachedConfig(testFile, {});
    expect(first).toEqual({ cached: true });
    // Should be the exact same object reference (from cache)
    expect(first).toBe(second);
  });

  it('invalidateCache forces re-read', () => {
    writeJsonConfig(testFile, { v: 1 });
    const first = readCachedConfig(testFile, {});
    invalidateCache(testFile);
    writeJsonConfig(testFile, { v: 2 });
    const second = readCachedConfig(testFile, {});
    expect(first).toEqual({ v: 1 });
    expect(second).toEqual({ v: 2 });
  });
});
