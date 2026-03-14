import type { JarvisModule, ModuleName, PatternDefinition } from './types.js';

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
