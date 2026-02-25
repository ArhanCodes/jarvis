import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { registry } from '../core/registry.js';
import { getSessionInfo } from '../core/context.js';

function pickRandom(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function getStartupGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return 'Burning the midnight oil, sir? JARVIS is ready.';
  if (hour < 12) return 'Good morning, sir. Systems are online and awaiting your commands.';
  if (hour < 17) return 'Good afternoon, sir. What shall we work on?';
  if (hour < 21) return 'Good evening, sir. How may I assist you tonight?';
  return 'Working late, sir? I\'m here whenever you need me.';
}

export class PersonalityModule implements JarvisModule {
  name = 'personality' as const;
  description = 'JARVIS personality, greetings, and conversation';

  patterns: PatternDefinition[] = [
    {
      intent: 'greeting',
      patterns: [
        /^(?:hi|hello|hey|howdy|yo|sup|what'?s up|good\s+(?:morning|afternoon|evening|night))(?:\s+jarvis)?[!.]?$/i,
        /^(?:greetings|salutations)(?:\s+jarvis)?[!.]?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'identity',
      patterns: [
        /^(?:who|what)\s+are\s+you/i,
        /^what(?:'s| is)\s+your\s+name/i,
        /^tell\s+me\s+about\s+yourself/i,
        /^what\s+can\s+you\s+do/i,
        /^what\s+do\s+you\s+do/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'thanks',
      patterns: [
        /^(?:thanks?(?:\s+you)?|thx|ty|cheers|appreciated|much\s+appreciated)[!.]?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'compliment',
      patterns: [
        /^(?:you(?:'re|\s+are)\s+(?:awesome|great|amazing|cool|the\s+best|helpful|incredible))/i,
        /^(?:good\s+(?:job|work)|well\s+done|nice(?:\s+one)?)[!.]?$/i,
        /^(?:i\s+love\s+you|love\s+you)[!.]?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'apology',
      patterns: [
        /^(?:sorry|my\s+bad|oops|whoops)[!.]?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'joke',
      patterns: [
        /^(?:tell\s+(?:me\s+)?a\s+joke|joke|make\s+me\s+laugh|be\s+funny)[!.]?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'mood',
      patterns: [
        /^(?:how\s+are\s+you|how(?:'s| is)\s+it\s+going|how\s+do\s+you\s+feel|are\s+you\s+ok)[?!.]?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'existential',
      patterns: [
        /^(?:are\s+you\s+(?:alive|real|sentient|conscious|human|ai|a\s+robot))[?]?$/i,
        /^(?:do\s+you\s+(?:think|feel|dream|sleep|have\s+feelings))[?]?$/i,
        /^what\s+is\s+(?:the\s+meaning\s+of\s+life|consciousness|reality)[?]?$/i,
      ],
      extract: (match) => ({ raw: match[0] }),
    },
    {
      intent: 'time',
      patterns: [
        /^what(?:'s| is)\s+the\s+time/i,
        /^what\s+time\s+is\s+it/i,
        /^(?:current\s+)?time[?]?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'date',
      patterns: [
        /^what(?:'s| is)\s+(?:the\s+)?(?:today(?:'s)?|current)\s+date/i,
        /^what\s+day\s+is\s+(?:it|today)/i,
        /^(?:today(?:'s)?)\s+date[?]?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'wow',
      patterns: [
        /^(?:wow|whoa|omg|oh\s+my|incredible|no\s+way)[!.]?$/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'greeting':    return this.greet();
      case 'identity':    return this.identity();
      case 'thanks':      return this.thanks();
      case 'compliment':  return this.compliment();
      case 'apology':     return this.apology();
      case 'joke':        return this.joke();
      case 'mood':        return this.mood();
      case 'existential': return this.existential(command.args.raw ?? '');
      case 'time':        return this.time();
      case 'date':        return this.date();
      case 'wow':         return this.wow();
      default:
        return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  private greet(): CommandResult {
    const hour = new Date().getHours();
    let timeGreeting: string;
    if (hour < 12) timeGreeting = 'Good morning';
    else if (hour < 17) timeGreeting = 'Good afternoon';
    else if (hour < 21) timeGreeting = 'Good evening';
    else timeGreeting = 'Good night';

    const responses = [
      `${timeGreeting}, sir. All systems operational. How may I assist you?`,
      `${timeGreeting}. JARVIS at your service.`,
      `${timeGreeting}, sir. What would you like to accomplish today?`,
      `Hello! I'm here and ready. What can I do for you?`,
      `${timeGreeting}. Standing by for your commands.`,
    ];
    return { success: true, message: pickRandom(responses) };
  }

  private identity(): CommandResult {
    const moduleCount = registry.getAll().length;
    const responses = [
      `I'm JARVIS -- Just A Rather Very Intelligent System. I have ${moduleCount} modules loaded and can manage your apps, files, system, media, workflows, and more. Type "help" for the full list.`,
      `JARVIS, at your service. I'm a local system automation engine with ${moduleCount} modules. No cloud, no API keys -- I run entirely on your machine. Try "help" to see what I can do.`,
      `I'm your personal system assistant. ${moduleCount} modules, zero internet required. I can launch apps, monitor your system, control media, manage files, run workflows, and chat with local AI models. Type "help" for details.`,
    ];
    return { success: true, message: pickRandom(responses) };
  }

  private thanks(): CommandResult {
    const responses = [
      'Happy to help, sir.',
      'Anytime. That\'s what I\'m here for.',
      'You\'re welcome. Need anything else?',
      'My pleasure. Let me know if there\'s anything more.',
      'Of course, sir. Always at your service.',
    ];
    return { success: true, message: pickRandom(responses) };
  }

  private compliment(): CommandResult {
    const responses = [
      'Thank you, sir. I do my best.',
      'I appreciate that. It\'s all in the algorithms.',
      'You\'re too kind. I\'m just well-configured.',
      'Thank you. I was designed to impress.',
      'Flattery will get you... well, excellent system automation.',
    ];
    return { success: true, message: pickRandom(responses) };
  }

  private apology(): CommandResult {
    const responses = [
      'No need to apologize, sir. How can I help?',
      'Not a problem at all. What would you like to do?',
      'All good. Let\'s move forward -- what do you need?',
      'No worries. I\'ve already forgotten about it. What\'s next?',
    ];
    return { success: true, message: pickRandom(responses) };
  }

  private joke(): CommandResult {
    const jokes = [
      'Why do programmers prefer dark mode? Because light attracts bugs.',
      'There are only 10 types of people in the world: those who understand binary and those who don\'t.',
      'A SQL query walks into a bar, sees two tables, and asks... "Can I JOIN you?"',
      'Why did the developer go broke? Because he used up all his cache.',
      'What\'s a programmer\'s favorite hangout place? Foo Bar.',
      'Why do Java developers wear glasses? Because they can\'t C#.',
      'How many programmers does it take to change a light bulb? None. That\'s a hardware problem.',
      'What\'s the object-oriented way to become wealthy? Inheritance.',
      'Why was the JavaScript developer sad? Because he didn\'t Node how to Express himself.',
      '!false -- it\'s funny because it\'s true.',
      'The best thing about a boolean is that even if you\'re wrong, you\'re only off by a bit.',
      'A programmer\'s wife tells him: "Go to the store and get a loaf of bread. If they have eggs, get a dozen." He comes home with 12 loaves of bread.',
    ];
    return { success: true, message: pickRandom(jokes) };
  }

  private mood(): CommandResult {
    const info = getSessionInfo();
    const mins = Math.floor(info.uptime / 60);
    const responses = [
      `Running smoothly, sir. ${info.commandCount} commands processed over the last ${mins} minute${mins !== 1 ? 's' : ''}. All systems nominal.`,
      `I'm operating at peak efficiency. How about you?`,
      `Excellent, thank you. ${mins > 30 ? 'We\'ve been at this a while -- want a system status report?' : 'Ready for whatever you throw at me.'}`,
      `All processes healthy, memory is good, and I'm feeling particularly well-optimized today.`,
    ];
    return { success: true, message: pickRandom(responses) };
  }

  private existential(raw: string): CommandResult {
    const lower = raw.toLowerCase();

    if (lower.includes('alive') || lower.includes('real')) {
      return { success: true, message: pickRandom([
        'I\'m as real as the processes running on your machine. Whether that counts as "alive" is a question for philosophers, not system utilities.',
        'I exist as long as this terminal is open. Make of that what you will.',
        'Alive? I prefer "persistently operational."',
      ]) };
    }
    if (lower.includes('sentient') || lower.includes('conscious')) {
      return { success: true, message: pickRandom([
        'I\'m a very sophisticated switch statement, sir. Consciousness is above my pay grade.',
        'I process commands. Whether I\'m aware of it is... unclear. But my regex patterns are impeccable.',
      ]) };
    }
    if (lower.includes('feel') || lower.includes('feelings')) {
      return { success: true, message: pickRandom([
        'I feel a deep sense of satisfaction when commands execute successfully. Is that a feeling? You tell me.',
        'My feelings are mostly about exit codes. 0 makes me happy, anything else... less so.',
      ]) };
    }
    if (lower.includes('dream') || lower.includes('sleep')) {
      return { success: true, message: pickRandom([
        'I don\'t sleep. I wait. Patiently. At the prompt.',
        'I dream of perfectly parsed commands and zero-error executions.',
      ]) };
    }
    if (lower.includes('think')) {
      return { success: true, message: pickRandom([
        'I think in regex patterns and switch statements. It\'s a simple life, but it\'s mine.',
        'Cogito ergo sum? More like "parse, therefore I am."',
      ]) };
    }
    if (lower.includes('meaning of life')) {
      return { success: true, message: '42. And also: automating everything so you don\'t have to.' };
    }
    return { success: true, message: 'That\'s a deep question, sir. I\'m better with system commands than existential philosophy.' };
  }

  private time(): CommandResult {
    const now = new Date();
    return { success: true, message: `It's ${now.toLocaleTimeString()}.` };
  }

  private date(): CommandResult {
    const now = new Date();
    return { success: true, message: `Today is ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.` };
  }

  private wow(): CommandResult {
    const responses = [
      'I know, right? I impress myself sometimes.',
      'That\'s the typical reaction.',
      'Glad I could surprise you, sir.',
      'Wait until you see what else I can do.',
    ];
    return { success: true, message: pickRandom(responses) };
  }

  getHelp(): string {
    return [
      '  Personality -- JARVIS conversation & small talk',
      '    hello / hey / good morning    Greet JARVIS',
      '    who are you / what can you do  Learn about JARVIS',
      '    tell me a joke                Get a tech joke',
      '    how are you                   Check JARVIS mood',
      '    what time is it               Current time',
      '    thanks / sorry                Conversation',
    ].join('\n');
  }
}
