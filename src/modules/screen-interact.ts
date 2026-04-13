import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { osascript, getFrontmostApp, activateApp } from '../utils/osascript.js';
import { llmStreamChat, isLLMAvailable } from '../utils/llm.js';
import { fmt } from '../utils/formatter.js';
import { execSync } from 'child_process';
import { createLogger } from '../utils/logger.js';

const log = createLogger('screen-interact');

// ── Screen Interact Module ──
// Grab selected text (Cmd+C), process with AI, paste back (Cmd+V).
// Works in any app — "Jarvis paraphrase this", "Jarvis fix grammar", etc.

const PROMPTS: Record<string, string> = {
  paraphrase:  'Paraphrase the following text. Keep the same meaning and tone. Output ONLY the paraphrased text, nothing else:\n\n',
  rewrite:     'Rewrite the following text to be clearer and better written. Output ONLY the rewritten text, nothing else:\n\n',
  'fix-grammar': 'Fix all grammar and spelling errors in the following text. Change nothing else. Output ONLY the corrected text, nothing else:\n\n',
  summarize:   'Summarize the following text concisely. Output ONLY the summary, nothing else:\n\n',
  shorten:     'Make the following text shorter while keeping the key points. Output ONLY the shortened text, nothing else:\n\n',
  expand:      'Expand and elaborate on the following text. Output ONLY the expanded text, nothing else:\n\n',
  formal:      'Rewrite the following text in a formal, professional tone. Output ONLY the formal text, nothing else:\n\n',
  casual:      'Rewrite the following text in a casual, friendly tone. Output ONLY the casual text, nothing else:\n\n',
};

export class ScreenInteractModule implements JarvisModule {
  name = 'screen-interact' as const;
  description = 'Process selected text with AI (paraphrase, rewrite, fix grammar, etc.)';

  patterns: PatternDefinition[] = [
    {
      intent: 'paraphrase',
      patterns: [
        /^(?:jarvis\s+)?paraphrase\s+(?:this|that|it|the\s+text|selection|the\s+selection)$/i,
        /^(?:jarvis\s+)?paraphrase$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'rewrite',
      patterns: [
        /^(?:jarvis\s+)?(?:rewrite|rephrase)\s+(?:this|that|it|the\s+text|selection|the\s+selection)$/i,
        /^(?:jarvis\s+)?(?:rewrite|rephrase)$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'fix-grammar',
      patterns: [
        /^(?:jarvis\s+)?(?:fix|correct)\s+(?:the\s+)?(?:grammar|spelling|errors?)(?:\s+(?:in\s+)?(?:this|that))?$/i,
        /^(?:jarvis\s+)?(?:fix|correct)\s+(?:this|that)$/i,
        /^(?:jarvis\s+)?grammar\s+(?:check|fix)$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'summarize',
      patterns: [
        /^(?:jarvis\s+)?summarize\s+(?:this|that|it|the\s+text|selection|the\s+selection)$/i,
        /^(?:jarvis\s+)?(?:summarize|sum\s+up|tldr)$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'shorten',
      patterns: [
        /^(?:jarvis\s+)?(?:shorten|make\s+(?:this\s+|it\s+)?(?:shorter|concise|brief(?:er)?))$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'expand',
      patterns: [
        /^(?:jarvis\s+)?(?:expand|elaborate|make\s+(?:this\s+|it\s+)?(?:longer|more\s+detailed))$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'formal',
      patterns: [
        /^(?:jarvis\s+)?(?:make\s+(?:this\s+|it\s+)?(?:formal|professional)|formalize)$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'casual',
      patterns: [
        /^(?:jarvis\s+)?(?:make\s+(?:this\s+|it\s+)?(?:casual|informal|friendly))$/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    const intent = command.action;
    const prompt = PROMPTS[intent];
    if (!prompt) {
      return { success: false, message: `Unknown action: ${intent}` };
    }

    return this.processSelectedText(intent, prompt);
  }

  private async processSelectedText(intent: string, promptPrefix: string): Promise<CommandResult> {
    // Check LLM availability
    const llmUp = await isLLMAvailable();
    if (!llmUp) {
      return { success: false, message: 'Claude API is not configured. Cannot process text.', voiceMessage: 'AI is not available.' };
    }

    // 1. Remember which app is focused
    let frontApp: string;
    try {
      frontApp = (await getFrontmostApp()).trim();
    } catch (err) {
      log.debug('Could not get frontmost app', err);
      frontApp = '';
    }

    // 2. Save original clipboard so we can restore it after
    let originalClipboard = '';
    try {
      originalClipboard = execSync('pbpaste', { encoding: 'utf-8', timeout: 3000 });
    } catch (err) { log.debug('Could not read original clipboard', err); }

    // 3. Copy selected text (Cmd+C)
    try {
      await osascript('tell application "System Events" to keystroke "c" using {command down}');
    } catch (err) {
      return { success: false, message: `Failed to copy: ${(err as Error).message}`, voiceMessage: 'Failed to copy the selected text.' };
    }

    // Wait for clipboard to populate
    await new Promise(r => setTimeout(r, 300));

    // 4. Read clipboard
    let selectedText: string;
    try {
      selectedText = execSync('pbpaste', { encoding: 'utf-8', timeout: 3000 }).trim();
    } catch (err) {
      log.debug('Could not read clipboard after copy', err);
      return { success: false, message: 'Could not read clipboard.', voiceMessage: 'Could not read the clipboard.' };
    }

    if (!selectedText) {
      return { success: false, message: 'Nothing selected. Select some text first.', voiceMessage: 'Nothing is selected. Select some text first.' };
    }

    console.log(fmt.dim(`  [screen-interact] ${intent}: "${selectedText.slice(0, 80)}${selectedText.length > 80 ? '...' : ''}"`));

    // 5. Process with AI
    let result: string;
    try {
      process.stdout.write(fmt.dim('  Processing...\n'));
      result = await llmStreamChat(
        [{ role: 'user', content: promptPrefix + selectedText }],
        'You are a helpful text processing assistant. Only output the processed text, no explanations.',
        () => {},
      );
      if (!result?.trim()) {
        this.restoreClipboard(originalClipboard);
        return { success: false, message: 'AI returned empty result.', voiceMessage: 'The AI returned an empty result.' };
      }
      result = result.trim();
    } catch (err) {
      this.restoreClipboard(originalClipboard);
      return { success: false, message: `AI error: ${(err as Error).message}`, voiceMessage: 'Something went wrong processing the text.' };
    }

    console.log(fmt.dim(`  [screen-interact] Result: "${result.slice(0, 80)}${result.length > 80 ? '...' : ''}"`));

    // 6. Write result to clipboard
    try {
      execSync('pbcopy', { input: result, timeout: 3000 });
    } catch (err) {
      log.debug('Could not write to clipboard', err);
      this.restoreClipboard(originalClipboard);
      return { success: false, message: 'Could not write to clipboard.', voiceMessage: 'Could not write to the clipboard.' };
    }

    // 7. Refocus the original app and paste
    try {
      if (frontApp) {
        await activateApp(frontApp);
        await new Promise(r => setTimeout(r, 200));
      }
      await osascript('tell application "System Events" to keystroke "v" using {command down}');
    } catch (err) {
      // Paste failed but result is on clipboard — don't restore since user may want to paste manually
      return {
        success: true,
        message: `Text processed (${intent}). Result is on your clipboard — paste manually.`,
        voiceMessage: `Done. The ${intent} result is on your clipboard.`,
      };
    }

    // 8. Restore original clipboard after short delay
    setTimeout(() => this.restoreClipboard(originalClipboard), 500);

    return {
      success: true,
      message: `Text ${intent === 'fix-grammar' ? 'corrected' : intent + 'd'} and pasted.`,
      voiceMessage: 'Done.',
    };
  }

  private restoreClipboard(content: string): void {
    try {
      execSync('pbcopy', { input: content, timeout: 3000 });
    } catch (err) { log.debug('Could not restore clipboard', err); }
  }

  getHelp(): string {
    return [
      '  Screen Interact — AI text processing on selected text',
      '    paraphrase this          Paraphrase selected text',
      '    rewrite this             Rewrite selected text',
      '    fix grammar              Fix grammar & spelling',
      '    summarize this           Summarize selected text',
      '    shorten this             Make text more concise',
      '    expand this              Elaborate on text',
      '    make this formal         Formal/professional tone',
      '    make this casual         Casual/friendly tone',
    ].join('\n');
  }
}
