import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { JarvisModule, ModuleName, PatternDefinition } from './types.js';

// ---------------------------------------------------------------------------
// Module lifecycle hooks — modules can optionally implement these
// ---------------------------------------------------------------------------

export interface ModuleLifecycle {
  onBoot?(): Promise<void>;
  onShutdown?(): Promise<void>;
  onError?(error: Error): void;
}

// ---------------------------------------------------------------------------
// Plugin manifest
// ---------------------------------------------------------------------------

export interface PluginManifest {
  name: string;
  version: string;
  modules: string[]; // paths to module files relative to manifest
}

// ---------------------------------------------------------------------------
// Decorator-based auto-registration
// ---------------------------------------------------------------------------

const pendingModules: Array<new (...args: any[]) => JarvisModule> = [];

/**
 * Decorator that marks a class for auto-registration.
 * The class is stored in a pending list and instantiated + registered
 * during boot via `registerPendingModules()`.
 *
 * Usage:
 *   @RegisterModule()
 *   export class TimerModule implements JarvisModule { ... }
 */
export function RegisterModule() {
  return function <T extends new (...args: any[]) => JarvisModule>(constructor: T) {
    pendingModules.push(constructor);
    return constructor;
  };
}

/**
 * Instantiate and register every module that was collected via the
 * `@RegisterModule()` decorator.  Safe to call multiple times — each
 * pending module is only registered once.
 */
export async function registerPendingModules(): Promise<void> {
  while (pendingModules.length > 0) {
    const Ctor = pendingModules.shift()!;
    const instance = new Ctor();
    registry.register(instance);
  }
}

// ---------------------------------------------------------------------------
// Auto-discovery of generated modules
// ---------------------------------------------------------------------------

/**
 * Scan `src/modules/generated/` for JS/TS module files, dynamically import
 * each one, and register any exported JarvisModule instances or classes
 * decorated with @RegisterModule().
 */
export async function discoverGeneratedModules(): Promise<void> {
  const generatedDir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../modules/generated',
  );

  if (!fs.existsSync(generatedDir)) {
    return; // nothing to discover
  }

  const entries = fs.readdirSync(generatedDir).filter(
    (f) => f.endsWith('.js') || f.endsWith('.ts'),
  );

  for (const entry of entries) {
    try {
      const fullPath = path.join(generatedDir, entry);
      const fileUrl = pathToFileURL(fullPath).href;
      const mod = await import(fileUrl);

      // If the file exports a default JarvisModule instance, register it
      if (mod.default && isJarvisModule(mod.default)) {
        registry.register(mod.default);
      }

      // Also check all named exports for module instances
      for (const key of Object.keys(mod)) {
        if (key === 'default') continue;
        const val = mod[key];
        if (isJarvisModule(val)) {
          registry.register(val);
        }
      }
    } catch (err) {
      console.error(`[registry] Failed to load generated module ${entry}:`, err);
    }
  }

  // Any @RegisterModule()-decorated classes imported above are now pending
  await registerPendingModules();
}

// ---------------------------------------------------------------------------
// Plugin system
// ---------------------------------------------------------------------------

const loadedPlugins: PluginManifest[] = [];

/**
 * Load a plugin from its manifest file.  The manifest lists module file
 * paths (relative to the manifest directory); each is dynamically imported
 * and its exports are registered.
 */
export async function loadPlugin(manifestPath: string): Promise<void> {
  const absolutePath = path.resolve(manifestPath);
  const raw = fs.readFileSync(absolutePath, 'utf-8');
  const manifest: PluginManifest = JSON.parse(raw);
  const manifestDir = path.dirname(absolutePath);

  for (const modulePath of manifest.modules) {
    try {
      const fullPath = path.resolve(manifestDir, modulePath);
      const fileUrl = pathToFileURL(fullPath).href;
      const mod = await import(fileUrl);

      if (mod.default && isJarvisModule(mod.default)) {
        registry.register(mod.default);
      }

      for (const key of Object.keys(mod)) {
        if (key === 'default') continue;
        const val = mod[key];
        if (isJarvisModule(val)) {
          registry.register(val);
        }
      }
    } catch (err) {
      console.error(`[registry] Failed to load plugin module ${modulePath} from ${manifest.name}:`, err);
    }
  }

  // Register any decorator-based modules from the plugin
  await registerPendingModules();

  loadedPlugins.push(manifest);
}

/**
 * Return all loaded plugin manifests.
 */
export function getPlugins(): PluginManifest[] {
  return [...loadedPlugins];
}

// ---------------------------------------------------------------------------
// Lifecycle management
// ---------------------------------------------------------------------------

/**
 * Call `onBoot()` on every registered module that implements the hook.
 */
export async function bootModules(): Promise<void> {
  for (const mod of registry.getAll()) {
    const lc = mod as unknown as ModuleLifecycle;
    if (typeof lc.onBoot === 'function') {
      try {
        await lc.onBoot();
      } catch (err) {
        console.error(`[registry] onBoot failed for ${mod.name}:`, err);
        if (typeof lc.onError === 'function') {
          lc.onError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
  }
}

/**
 * Call `onShutdown()` on every registered module that implements the hook.
 */
export async function shutdownModules(): Promise<void> {
  for (const mod of registry.getAll()) {
    const lc = mod as unknown as ModuleLifecycle;
    if (typeof lc.onShutdown === 'function') {
      try {
        await lc.onShutdown();
      } catch (err) {
        console.error(`[registry] onShutdown failed for ${mod.name}:`, err);
      }
    }
  }
}

/**
 * Notify a module's `onError` hook, if it exists.
 */
export function notifyModuleError(moduleName: ModuleName, error: Error): void {
  const mod = registry.get(moduleName);
  if (!mod) return;
  const lc = mod as unknown as ModuleLifecycle;
  if (typeof lc.onError === 'function') {
    lc.onError(error);
  }
}

// ---------------------------------------------------------------------------
// Core registry (backward-compatible)
// ---------------------------------------------------------------------------

function isJarvisModule(obj: unknown): obj is JarvisModule {
  if (obj == null || typeof obj !== 'object') return false;
  const m = obj as Record<string, unknown>;
  return (
    typeof m.name === 'string' &&
    typeof m.description === 'string' &&
    Array.isArray(m.patterns) &&
    typeof m.execute === 'function' &&
    typeof m.getHelp === 'function'
  );
}

class ModuleRegistry {
  private modules: Map<ModuleName, JarvisModule> = new Map();

  register(module: JarvisModule): void {
    this.modules.set(module.name, module);
  }

  get(name: ModuleName): JarvisModule | undefined {
    return this.modules.get(name);
  }

  getAll(): JarvisModule[] {
    return Array.from(this.modules.values());
  }

  getAllPatterns(): Array<{ module: ModuleName; pattern: PatternDefinition }> {
    const result: Array<{ module: ModuleName; pattern: PatternDefinition }> = [];
    for (const mod of this.modules.values()) {
      for (const p of mod.patterns) {
        result.push({ module: mod.name, pattern: p });
      }
    }
    return result;
  }
}

export const registry = new ModuleRegistry();
