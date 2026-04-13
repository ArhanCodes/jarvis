import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { loadPlugin, type PluginManifest } from './registry.js';
import { configPath, getProjectRoot } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('plugin-loader');

// ---------------------------------------------------------------------------
// Config path
// ---------------------------------------------------------------------------

const PLUGINS_CONFIG = configPath('plugins.json');

interface PluginsConfig {
  plugins: string[]; // manifest paths (absolute or relative to project root)
}

function readConfig(): PluginsConfig {
  if (!fs.existsSync(PLUGINS_CONFIG)) {
    return { plugins: [] };
  }
  const raw = fs.readFileSync(PLUGINS_CONFIG, 'utf-8');
  return JSON.parse(raw) as PluginsConfig;
}

function writeConfig(config: PluginsConfig): void {
  const dir = path.dirname(PLUGINS_CONFIG);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(PLUGINS_CONFIG, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read `config/plugins.json` and load every plugin listed there.
 */
export async function loadPluginsFromConfig(): Promise<void> {
  const config = readConfig();
  const projectRoot = getProjectRoot();

  for (const manifestPath of config.plugins) {
    const resolved = path.isAbsolute(manifestPath)
      ? manifestPath
      : path.resolve(projectRoot, manifestPath);

    try {
      await loadPlugin(resolved);
    } catch (err) {
      log.error(`Failed to load plugin from ${resolved}`, err);
    }
  }
}

/**
 * Install a plugin from an npm package, git URL, or local path.
 *
 * - npm package: `installPlugin("jarvis-plugin-foo")`
 * - git URL:     `installPlugin("https://github.com/user/jarvis-plugin-foo.git")`
 * - local path:  `installPlugin("./my-plugins/foo")`
 *
 * After installation the plugin's manifest is located and added to
 * `config/plugins.json`, then the plugin is loaded immediately.
 */
export async function installPlugin(source: string): Promise<void> {
  const projectRoot = getProjectRoot();

  // Determine if source is a local directory that already exists
  const localResolved = path.resolve(projectRoot, source);
  const isLocalDir = fs.existsSync(localResolved) && fs.statSync(localResolved).isDirectory();

  let manifestPath: string;

  if (isLocalDir) {
    // Local path — look for manifest directly
    manifestPath = findManifest(localResolved);
  } else {
    // npm install (handles npm names, git URLs, tarballs)
    try {
      execSync(`npm install ${source}`, { cwd: projectRoot, stdio: 'pipe' });
    } catch (err) {
      throw new Error(`Failed to npm install "${source}": ${err}`);
    }

    // Derive the package name for node_modules lookup
    const packageName = derivePackageName(source);
    const packageDir = path.join(projectRoot, 'node_modules', packageName);

    if (!fs.existsSync(packageDir)) {
      throw new Error(`Package directory not found after install: ${packageDir}`);
    }

    manifestPath = findManifest(packageDir);
  }

  // Add to config
  const config = readConfig();
  if (!config.plugins.includes(manifestPath)) {
    config.plugins.push(manifestPath);
    writeConfig(config);
  }

  // Load immediately
  await loadPlugin(manifestPath);
}

/**
 * Uninstall a plugin by name — removes it from `config/plugins.json`
 * and runs `npm uninstall` if applicable.
 */
export async function uninstallPlugin(name: string): Promise<void> {
  const projectRoot = getProjectRoot();
  const config = readConfig();

  // Find matching entry by plugin name in manifest
  const remaining: string[] = [];
  let found = false;

  for (const manifestPath of config.plugins) {
    const resolved = path.isAbsolute(manifestPath)
      ? manifestPath
      : path.resolve(projectRoot, manifestPath);

    let pluginName: string | undefined;
    try {
      const raw = fs.readFileSync(resolved, 'utf-8');
      const manifest: PluginManifest = JSON.parse(raw);
      pluginName = manifest.name;
    } catch (err) {
      log.debug('Could not read plugin manifest', err);
    }

    if (pluginName === name) {
      found = true;
      // If it lives in node_modules, npm uninstall it
      if (resolved.includes('node_modules')) {
        try {
          execSync(`npm uninstall ${name}`, { cwd: projectRoot, stdio: 'pipe' });
        } catch (err) {
          log.warn(`npm uninstall ${name} failed — manual cleanup may be needed`, err);
        }
      }
    } else {
      remaining.push(manifestPath);
    }
  }

  if (!found) {
    throw new Error(`Plugin "${name}" not found in config/plugins.json`);
  }

  config.plugins = remaining;
  writeConfig(config);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Locate a `jarvis-plugin.json` (preferred) or `plugin.json` manifest
 * inside the given directory.
 */
function findManifest(dir: string): string {
  for (const candidate of ['jarvis-plugin.json', 'plugin.json']) {
    const p = path.join(dir, candidate);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`No plugin manifest found in ${dir} (expected jarvis-plugin.json or plugin.json)`);
}

/**
 * Best-effort derivation of npm package name from an install source string.
 */
function derivePackageName(source: string): string {
  // Scoped package: @scope/name
  if (source.startsWith('@')) {
    const match = source.match(/^(@[^/]+\/[^@/]+)/);
    if (match) return match[1];
  }

  // Plain name, possibly with version: "foo@1.2.3"
  const atIdx = source.indexOf('@', 1);
  if (atIdx > 0) return source.slice(0, atIdx);

  // Git URL: extract repo name
  if (source.includes('://') || source.endsWith('.git')) {
    const repoMatch = source.match(/\/([^/]+?)(?:\.git)?$/);
    if (repoMatch) return repoMatch[1];
  }

  return source;
}
