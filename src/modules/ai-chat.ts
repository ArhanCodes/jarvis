import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { isOllamaRunning, listModels, chatStream, generate, type OllamaChatMessage } from '../utils/ollama.js';
import { fmt } from '../utils/formatter.js';

const MAX_HISTORY_MESSAGES = 20;
const MAX_FILE_CHARS = 50_000;

let activeModel = 'llama3';
let conversationHistory: OllamaChatMessage[] = [];
let ollamaAvailable: boolean | null = null;

function resolvePath(p: string): string {
  if (p.startsWith('~')) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

export class AIChatModule implements JarvisModule {
  name = 'ai-chat' as const;
  description = 'Chat with local AI models via Ollama';

  patterns: PatternDefinition[] = [
    {
      intent: 'ask',
      patterns: [
        /^(?:ask|ai|chat)\s+(.+)/i,
        /^(?:hey\s+)?jarvis[,]?\s+(?:can you|please|could you)\s+(.+)/i,
      ],
      extract: (match) => ({ prompt: (match[1] || match[2]).trim() }),
    },
    {
      intent: 'summarize',
      patterns: [
        /^summarize\s+(?:file\s+)?(.+)/i,
        /^(?:give\s+me\s+a\s+)?summary\s+(?:of\s+)?(.+)/i,
        /^tldr\s+(.+)/i,
      ],
      extract: (match) => ({ file: (match[1] || match[2] || match[3]).trim() }),
    },
    {
      intent: 'explain',
      patterns: [
        /^explain\s+(?:file\s+|code\s+(?:in\s+)?)?(.+)/i,
      ],
      extract: (match) => ({ file: match[1].trim() }),
    },
    {
      intent: 'list-models',
      patterns: [
        /^(?:list\s+)?models$/i,
        /^(?:show|available)\s+models$/i,
        /^(?:what|which)\s+models/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'switch-model',
      patterns: [
        /^(?:use|switch(?:\s+to)?|set)\s+model\s+(.+)/i,
        /^model\s+(.+)/i,
      ],
      extract: (match) => ({ model: match[1].trim() }),
    },
    {
      intent: 'clear-chat',
      patterns: [
        /^(?:clear|reset)\s+(?:chat|conversation|context)/i,
        /^new\s+(?:chat|conversation)/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'ai-status',
      patterns: [
        /^(?:ai|ollama)\s+status$/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'ask':          return this.handleAsk(command.args.prompt);
      case 'summarize':    return this.handleSummarize(command.args.file);
      case 'explain':      return this.handleExplain(command.args.file);
      case 'list-models':  return this.handleListModels();
      case 'switch-model': return this.handleSwitchModel(command.args.model);
      case 'clear-chat':   return this.handleClearChat();
      case 'ai-status':    return this.handleStatus();
      default:
        return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  private async ensureOllama(): Promise<boolean> {
    if (ollamaAvailable === null) {
      ollamaAvailable = await isOllamaRunning();
      if (ollamaAvailable) {
        try {
          const models = await listModels();
          if (models.length > 0 && !models.find(m => m.name.startsWith(activeModel))) {
            activeModel = models[0].name;
          }
        } catch { /* keep default */ }
      }
    }
    return ollamaAvailable;
  }

  private ollamaNotRunning(): CommandResult {
    return {
      success: false,
      message: 'Ollama is not running. Install it from https://ollama.com and run "ollama serve" to enable AI features.',
    };
  }

  private async handleAsk(prompt: string): Promise<CommandResult> {
    if (!(await this.ensureOllama())) return this.ollamaNotRunning();

    conversationHistory.push({ role: 'user', content: prompt });

    // Trim history to sliding window
    if (conversationHistory.length > MAX_HISTORY_MESSAGES) {
      conversationHistory = conversationHistory.slice(-MAX_HISTORY_MESSAGES);
    }

    try {
      process.stdout.write(fmt.dim(`  [${activeModel}]\n`));
      process.stdout.write('  ');

      const fullResponse = await chatStream(activeModel, conversationHistory, (token) => {
        process.stdout.write(token);
      });

      process.stdout.write('\n\n');
      conversationHistory.push({ role: 'assistant', content: fullResponse });

      return { success: true, message: '', streamed: true };
    } catch (err) {
      conversationHistory.pop(); // Remove the user message on failure
      ollamaAvailable = null; // Re-check next time
      return { success: false, message: `AI error: ${(err as Error).message}` };
    }
  }

  private async handleSummarize(target: string): Promise<CommandResult> {
    if (!(await this.ensureOllama())) return this.ollamaNotRunning();

    const resolved = resolvePath(target);
    if (existsSync(resolved)) {
      return this.generateFromFile(resolved, 'Summarize the following content concisely. Provide key points and a brief overview:\n\n');
    }
    // Treat as a topic
    try {
      const response = await generate(activeModel, `Summarize the following topic concisely: ${target}`);
      return { success: true, message: response.trim() };
    } catch (err) {
      return { success: false, message: `AI error: ${(err as Error).message}` };
    }
  }

  private async handleExplain(target: string): Promise<CommandResult> {
    if (!(await this.ensureOllama())) return this.ollamaNotRunning();

    const resolved = resolvePath(target);
    if (existsSync(resolved)) {
      return this.generateFromFile(resolved, 'Explain the following code. Describe what it does, key patterns used, and anything noteworthy:\n\n');
    }
    // Treat as a topic
    try {
      const response = await generate(activeModel, `Explain the following clearly and concisely: ${target}`);
      return { success: true, message: response.trim() };
    } catch (err) {
      return { success: false, message: `AI error: ${(err as Error).message}` };
    }
  }

  private async generateFromFile(filePath: string, systemPrompt: string): Promise<CommandResult> {
    try {
      let content = readFileSync(filePath, 'utf-8');
      let note = '';
      if (content.length > MAX_FILE_CHARS) {
        content = content.slice(0, MAX_FILE_CHARS);
        note = ' (Note: file was truncated to first 50,000 characters)';
      }

      process.stdout.write(fmt.dim(`  [${activeModel}] Processing ${filePath}...${note}\n`));
      process.stdout.write('  ');

      const fullResponse = await chatStream(
        activeModel,
        [{ role: 'user', content: systemPrompt + content }],
        (token) => { process.stdout.write(token); },
      );

      process.stdout.write('\n\n');
      return { success: true, message: '', streamed: true };
    } catch (err) {
      return { success: false, message: `AI error: ${(err as Error).message}` };
    }
  }

  private async handleListModels(): Promise<CommandResult> {
    if (!(await this.ensureOllama())) return this.ollamaNotRunning();

    try {
      const models = await listModels();
      if (models.length === 0) {
        return { success: true, message: 'No models installed. Run "ollama pull llama3" to download a model.' };
      }

      const lines = models.map(m => {
        const sizeGB = (m.size / 1_073_741_824).toFixed(1);
        const marker = m.name === activeModel || m.name.startsWith(activeModel + ':') ? ' <-- active' : '';
        return `    ${m.name} (${sizeGB} GB)${marker}`;
      });

      return { success: true, message: `Available models:\n${lines.join('\n')}` };
    } catch (err) {
      return { success: false, message: `Failed to list models: ${(err as Error).message}` };
    }
  }

  private async handleSwitchModel(model: string): Promise<CommandResult> {
    if (!(await this.ensureOllama())) return this.ollamaNotRunning();

    activeModel = model;
    conversationHistory = []; // Clear context on model switch
    return { success: true, message: `Switched to model "${model}". Conversation cleared.` };
  }

  private handleClearChat(): CommandResult {
    conversationHistory = [];
    return { success: true, message: 'Conversation history cleared.' };
  }

  private async handleStatus(): Promise<CommandResult> {
    const running = await isOllamaRunning();
    ollamaAvailable = running;

    if (!running) {
      return { success: true, message: 'Ollama: not running\n    Install from https://ollama.com and run "ollama serve"' };
    }

    let modelCount = 0;
    try {
      const models = await listModels();
      modelCount = models.length;
    } catch { /* ignore */ }

    return {
      success: true,
      message: [
        `Ollama: running`,
        `    Active model: ${activeModel}`,
        `    Models installed: ${modelCount}`,
        `    Conversation: ${conversationHistory.length} messages`,
      ].join('\n'),
    };
  }

  getHelp(): string {
    return [
      '  AI Chat -- local LLM via Ollama (free, no API keys)',
      '    ask <question>           Chat with AI',
      '    ai <prompt>              Send a prompt',
      '    summarize <file|topic>   Summarize a file or topic',
      '    explain <file|topic>     Explain code or a concept',
      '    models                   List available models',
      '    use model <name>         Switch AI model',
      '    clear chat               Reset conversation',
      '    ai status                Check Ollama status',
    ].join('\n');
  }
}
