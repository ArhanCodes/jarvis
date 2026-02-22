import type { ParsedCommand, CommandResult } from './types.js';
import { registry } from './registry.js';

export async function execute(command: ParsedCommand): Promise<CommandResult> {
  const module = registry.get(command.module);
  if (!module) {
    return { success: false, message: `Module "${command.module}" is not registered.` };
  }

  try {
    return await module.execute(command);
  } catch (err) {
    return {
      success: false,
      message: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
