// ---------------------------------------------------------------------------
// Centralized Config System
// ---------------------------------------------------------------------------
// Single source of truth for config path resolution and JSON config I/O.
// Replaces the scattered getConfigPath / resolveConfigPath patterns.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Root Resolution
// ---------------------------------------------------------------------------

let _projectRoot: string | null = null;

/**
 * Find the project root (directory containing package.json + config/).
 * Caches the result after first call.
 */
export function getProjectRoot(): string {
  if (_projectRoot) return _projectRoot;

  // Best strategy: use cwd (JARVIS is always started from project root)
  const cwd = process.cwd();
  if (existsSync(join(cwd, 'package.json')) && existsSync(join(cwd, 'config'))) {
    _projectRoot = cwd;
    return _projectRoot;
  }

  // Fallback: walk up from this file's compiled location
  // This file lives at dist/utils/config.js or src/utils/config.ts
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (
      existsSync(join(dir, 'package.json')) &&
      existsSync(join(dir, 'config')) &&
      !dir.includes('/dist')
    ) {
      _projectRoot = dir;
      return _projectRoot;
    }
    dir = join(dir, '..');
  }

  // Last resort
  _projectRoot = cwd;
  return _projectRoot;
}

// ---------------------------------------------------------------------------
// Path Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a config file path. Always returns an absolute path under config/.
 * Creates the config directory if it doesn't exist.
 */
export function configPath(filename: string): string {
  const dir = join(getProjectRoot(), 'config');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, filename);
}

/**
 * Resolve a path relative to the project root.
 */
export function projectPath(...segments: string[]): string {
  return join(getProjectRoot(), ...segments);
}

// ---------------------------------------------------------------------------
// JSON Config I/O
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON config file. Returns the fallback on any error.
 */
export function readJsonConfig<T>(filename: string, fallback: T): T {
  const path = configPath(filename);
  if (!existsSync(path)) return fallback;

  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(`[config] Failed to parse ${filename}:`, (err as Error).message);
    return fallback;
  }
}

/**
 * Write a JSON config file atomically (write to same path, pretty-printed).
 */
export function writeJsonConfig<T>(filename: string, data: T): void {
  const path = configPath(filename);
  const dir = join(getProjectRoot(), 'config');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  try {
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[config] Failed to write ${filename}:`, (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Config Cache (mtime-based)
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T;
  mtime: number;
  path: string;
}

const cache = new Map<string, CacheEntry<unknown>>();

/**
 * Read a config file with mtime-based caching.
 * Re-reads from disk only when the file has been modified.
 */
export function readCachedConfig<T>(filename: string, fallback: T): T {
  const path = configPath(filename);
  if (!existsSync(path)) return fallback;

  try {
    const mtime = statSync(path).mtimeMs;
    const cached = cache.get(filename) as CacheEntry<T> | undefined;

    if (cached && cached.mtime === mtime) {
      return cached.data;
    }

    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw) as T;
    cache.set(filename, { data, mtime, path });
    return data;
  } catch (err) {
    console.warn(`[config] Failed to read cached ${filename}:`, (err as Error).message);
    return fallback;
  }
}

/**
 * Invalidate a cached config entry.
 */
export function invalidateCache(filename: string): void {
  cache.delete(filename);
}
