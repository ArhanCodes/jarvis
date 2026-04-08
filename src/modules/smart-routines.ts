import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { parse } from '../core/parser.js';
import { execute } from '../core/executor.js';
import { fmt } from '../utils/formatter.js';
import { speak, isVoiceEnabled } from '../utils/voice-output.js';
import { flushHistory } from '../core/history.js';

// ── Smart Routines Module ──
// Hardcoded "good morning" and "good night" routines with voice feedback.

interface RoutineStep {
  command: string;
  description: string;
}

interface Routine {
  name: string;
  greeting: string;            // What JARVIS says when the routine starts
  steps: RoutineStep[];
}

const ROUTINES: Record<string, Routine> = {
  'good morning': {
    name: 'Good Morning',
    greeting: 'Good morning sir. Let me get everything set up for you.',
    steps: [
      { command: 'open Microsoft Teams', description: 'Opening Teams' },
      { command: 'open Microsoft OneNote', description: 'Opening OneNote' },
      { command: 'news', description: 'Getting headlines' },
    ],
  },
  'good night': {
    name: 'Good Night',
    greeting: 'Good night sir. Shutting everything down.',
    steps: [
      { command: 'close Microsoft Teams', description: 'Closing Teams' },
      { command: 'close Microsoft OneNote', description: 'Closing OneNote' },
      { command: 'sleep', description: 'Putting Mac to sleep' },
      { command: 'exit', description: 'Shutting down' },
    ],
  },
};

export class SmartRoutinesModule implements JarvisModule {
  name = 'smart-routines' as const;
  description = 'Voice-triggered routines like good morning and good night';

  patterns: PatternDefinition[] = [
    {
      intent: 'good-morning',
      patterns: [
        /^good\s*morning(?:\s+jarvis)?[!.]?$/i,
        /^(?:start|begin)\s+(?:my\s+)?(?:morning|day)/i,
        /^morning\s+routine$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'good-night',
      patterns: [
        /^good\s*night(?:\s+jarvis)?[!.]?$/i,
        /^(?:shut(?:ting)?\s+down|end)\s+(?:my\s+)?day/i,
        /^(?:going to|time for)\s+(?:bed|sleep)/i,
        /^night\s+routine$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'list-routines',
      patterns: [
        /^(?:list|show)\s+routines$/i,
        /^routines$/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'good-morning':
        return this.runRoutine('good morning');
      case 'good-night':
        return this.runRoutine('good night');
      case 'list-routines':
        return this.listRoutines();
      default:
        return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  private async runRoutine(key: string): Promise<CommandResult> {
    const routine = ROUTINES[key];
    if (!routine) {
      return { success: false, message: `Routine "${key}" not found` };
    }

    // Speak the greeting
    console.log(fmt.info(`Running "${routine.name}" routine...`));
    if (isVoiceEnabled()) {
      await speak(routine.greeting);
    }

    const results: { step: string; ok: boolean; msg: string }[] = [];

    for (const step of routine.steps) {
      console.log(fmt.dim(`  [routine] ${step.description}...`));

      // Special case: "exit" — shut down JARVIS after a delay (lets sleep initiate first)
      if (step.command === 'exit') {
        results.push({ step: step.description, ok: true, msg: 'Shutting down' });
        if (isVoiceEnabled()) {
          await speak('Goodbye sir.');
        }
        console.log(fmt.info('Goodbye, sir.'));
        flushHistory();
        // Delay to let the sleep command take effect before process exits
        setTimeout(() => process.exit(0), 2000);
        break;
      }

      // Special case: "news" for morning routine — get top 3 headlines and speak them
      if (step.command === 'news') {
        const parsed = await parse(step.command);
        if (parsed) {
          const result = await execute(parsed);
          results.push({ step: step.description, ok: result.success, msg: result.message });
          if (result.success) {
            console.log(fmt.success(result.message));
            // Speak top 3 headlines in a voice-friendly way
            if (isVoiceEnabled() && result.message) {
              const lines = result.message.split('\n').slice(1, 4); // skip "Top headlines:" header, get 3
              const spoken = lines.map(l => l.replace(/^\s*\d+\.\s*/, '').trim()).filter(Boolean);
              if (spoken.length > 0) {
                await speak(`Here are today's top headlines. ${spoken.join('. ')}.`);
              }
            }
          } else {
            console.log(fmt.error(result.message));
          }
        }
        continue;
      }

      const parsed = await parse(step.command);
      if (!parsed) {
        console.log(fmt.error(`  Could not parse: "${step.command}"`));
        results.push({ step: step.description, ok: false, msg: 'parse error' });
        continue;
      }

      const result = await execute(parsed);
      results.push({ step: step.description, ok: result.success, msg: result.message });

      if (result.success) {
        console.log(fmt.success(result.message));
      } else {
        console.log(fmt.error(result.message));
      }
    }

    const passed = results.filter(r => r.ok).length;
    return {
      success: passed > 0,
      message: `${routine.name} routine complete: ${passed}/${results.length} steps succeeded`,
    };
  }

  private listRoutines(): CommandResult {
    const lines: string[] = [];
    for (const [trigger, routine] of Object.entries(ROUTINES)) {
      const steps = routine.steps.map(s => `      • ${s.description}`).join('\n');
      lines.push(`    "${trigger}" — ${routine.name}\n${steps}`);
    }
    return { success: true, message: `Available routines:\n${lines.join('\n\n')}` };
  }

  getHelp(): string {
    return [
      '  Smart Routines — voice-triggered command chains',
      '    good morning          Open Teams & OneNote, read news',
      '    good night            Close apps, sleep, and exit',
      '    routines              List available routines',
    ].join('\n');
  }
}
