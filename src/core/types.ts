export type ModuleName =
  | 'app-launcher'
  | 'script-runner'
  | 'system-monitor'
  | 'file-ops'
  | 'system-control'
  | 'timer'
  | 'process-manager'
  | 'clipboard'
  | 'window-manager'
  | 'media-control'
  | 'workflow'
  | 'ai-chat'
  | 'smart-assist'
  | 'personality';

export interface ParsedCommand {
  module: ModuleName;
  action: string;
  args: Record<string, string>;
  raw: string;
  confidence: number;
}

export interface CommandResult {
  success: boolean;
  message: string;
  data?: unknown;
  streamed?: boolean;
}

export interface PatternDefinition {
  intent: string;
  patterns: RegExp[];
  extract: (match: RegExpMatchArray, raw: string) => Record<string, string>;
}

export interface JarvisModule {
  name: ModuleName;
  description: string;
  patterns: PatternDefinition[];
  execute(command: ParsedCommand): Promise<CommandResult>;
  getHelp(): string;
}
