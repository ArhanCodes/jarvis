import type { ParsedCommand, CommandResult } from './types.js';

interface JarvisContext {
  lastCommand: ParsedCommand | null;
  lastResult: CommandResult | null;
  variables: Map<string, string>;
  sessionStart: number;
  commandCount: number;
}

const ctx: JarvisContext = {
  lastCommand: null,
  lastResult: null,
  variables: new Map(),
  sessionStart: Date.now(),
  commandCount: 0,
};

export function setLast(command: ParsedCommand, result: CommandResult): void {
  ctx.lastCommand = command;
  ctx.lastResult = result;
  ctx.commandCount++;
}

export function getLast(): { command: ParsedCommand | null; result: CommandResult | null } {
  return { command: ctx.lastCommand, result: ctx.lastResult };
}

export function setVar(key: string, value: string): void {
  ctx.variables.set(key.toLowerCase(), value);
}

export function getVar(key: string): string | undefined {
  return ctx.variables.get(key.toLowerCase());
}

export function getAllVars(): Map<string, string> {
  return ctx.variables;
}

export function getSessionInfo(): { uptime: number; commandCount: number } {
  return {
    uptime: Math.round((Date.now() - ctx.sessionStart) / 1000),
    commandCount: ctx.commandCount,
  };
}

// Expand $VAR references in a string
export function expandVariables(input: string): string {
  return input.replace(/\$\{?(\w+)\}?/g, (match, varName) => {
    // Built-in variables
    const builtins: Record<string, () => string> = {
      HOME: () => process.env.HOME ?? '~',
      USER: () => process.env.USER ?? 'unknown',
      DATE: () => new Date().toLocaleDateString(),
      TIME: () => new Date().toLocaleTimeString(),
      NOW: () => new Date().toISOString(),
      PWD: () => process.cwd(),
      UPTIME: () => String(getSessionInfo().uptime),
    };

    if (varName.toUpperCase() in builtins) {
      return builtins[varName.toUpperCase()]();
    }

    // User-defined variables
    const val = getVar(varName);
    if (val !== undefined) return val;

    // Environment variables
    const envVal = process.env[varName] ?? process.env[varName.toUpperCase()];
    if (envVal !== undefined) return envVal;

    return match; // Leave unresolved
  });
}
