import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { run } from '../utils/shell.js';
import { osascript } from '../utils/osascript.js';

export class SystemControlModule implements JarvisModule {
  name = 'system-control' as const;
  description = 'Control volume, brightness, dark mode, Do Not Disturb, sleep, lock, and trash';

  patterns: PatternDefinition[] = [
    // ── Volume ──
    {
      intent: 'volume-set',
      patterns: [
        /^(?:set\s+)?volume\s+(?:to\s+)?(\d+)/i,
        /^vol\s+(\d+)/i,
      ],
      extract: (match) => ({ level: match[1] }),
    },
    {
      intent: 'volume-up',
      patterns: [
        /^volume\s+up/i,
        /^(?:turn\s+up|increase|raise)\s+(?:the\s+)?volume/i,
        /^louder/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'volume-down',
      patterns: [
        /^volume\s+down/i,
        /^(?:turn\s+down|decrease|lower)\s+(?:the\s+)?volume/i,
        /^quieter/i,
        /^softer/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'mute',
      patterns: [
        /^mute/i,
        /^(?:toggle\s+)?mute/i,
        /^silence/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'unmute',
      patterns: [
        /^unmute/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'volume-get',
      patterns: [
        /^(?:get\s+|show\s+|check\s+|what(?:'s| is)\s+(?:the\s+)?)volume/i,
        /^volume$/i,
      ],
      extract: () => ({}),
    },
    // ── Brightness ──
    {
      intent: 'brightness-set',
      patterns: [
        /^(?:set\s+)?brightness\s+(?:to\s+)?(\d+)/i,
      ],
      extract: (match) => ({ level: match[1] }),
    },
    {
      intent: 'brightness-up',
      patterns: [
        /^brightness\s+up/i,
        /^(?:turn\s+up|increase|raise)\s+(?:the\s+)?brightness/i,
        /^brighter/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'brightness-down',
      patterns: [
        /^brightness\s+down/i,
        /^(?:turn\s+down|decrease|lower)\s+(?:the\s+)?brightness/i,
        /^dimmer/i,
      ],
      extract: () => ({}),
    },
    // ── Dark Mode ──
    {
      intent: 'dark-mode-on',
      patterns: [
        /^dark\s+mode\s+on/i,
        /^(?:enable|activate|turn on)\s+dark\s+mode/i,
        /^go\s+dark/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'dark-mode-off',
      patterns: [
        /^dark\s+mode\s+off/i,
        /^(?:disable|deactivate|turn off)\s+dark\s+mode/i,
        /^light\s+mode/i,
        /^go\s+light/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'dark-mode-toggle',
      patterns: [
        /^(?:toggle\s+)?dark\s+mode$/i,
      ],
      extract: () => ({}),
    },
    // ── Do Not Disturb ──
    {
      intent: 'dnd-on',
      patterns: [
        /^(?:do not disturb|dnd)\s+on/i,
        /^(?:enable|turn on)\s+(?:do not disturb|dnd|focus)/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'dnd-off',
      patterns: [
        /^(?:do not disturb|dnd)\s+off/i,
        /^(?:disable|turn off)\s+(?:do not disturb|dnd|focus)/i,
      ],
      extract: () => ({}),
    },
    // ── Sleep / Lock / Screensaver ──
    {
      intent: 'sleep',
      patterns: [
        /^sleep/i,
        /^(?:put\s+(?:the\s+)?(?:computer|mac|machine)\s+to\s+)?sleep/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'lock',
      patterns: [
        /^lock(?:\s+screen)?/i,
        /^lock\s+(?:the\s+)?(?:computer|mac|machine)/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'screensaver',
      patterns: [
        /^screensaver/i,
        /^(?:start|show|activate)\s+screensaver/i,
      ],
      extract: () => ({}),
    },
    // ── Trash ──
    {
      intent: 'empty-trash',
      patterns: [
        /^empty\s+(?:the\s+)?trash/i,
        /^clean\s+(?:the\s+)?trash/i,
      ],
      extract: () => ({}),
    },
    // ── Shutdown / Restart ──
    {
      intent: 'shutdown',
      patterns: [
        /^(?:shut\s*down|power\s+off)\s*(?:the\s+)?(?:computer|mac)?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'restart',
      patterns: [
        /^restart\s*(?:the\s+)?(?:computer|mac)?$/i,
        /^reboot/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      // Volume
      case 'volume-set': return this.setVolume(parseInt(command.args.level, 10));
      case 'volume-up': return this.adjustVolume(10);
      case 'volume-down': return this.adjustVolume(-10);
      case 'mute': return this.setMute(true);
      case 'unmute': return this.setMute(false);
      case 'volume-get': return this.getVolume();
      // Brightness
      case 'brightness-set': return this.setBrightness(parseInt(command.args.level, 10));
      case 'brightness-up': return this.adjustBrightness(0.1);
      case 'brightness-down': return this.adjustBrightness(-0.1);
      // Dark mode
      case 'dark-mode-on': return this.setDarkMode(true);
      case 'dark-mode-off': return this.setDarkMode(false);
      case 'dark-mode-toggle': return this.toggleDarkMode();
      // DND
      case 'dnd-on': return this.setDnd(true);
      case 'dnd-off': return this.setDnd(false);
      // Sleep / Lock
      case 'sleep': return this.sleepMac();
      case 'lock': return this.lockScreen();
      case 'screensaver': return this.startScreensaver();
      // Trash
      case 'empty-trash': return this.emptyTrash();
      // Power
      case 'shutdown': return this.shutdown();
      case 'restart': return this.restart();
      default: return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  // ── Volume ──
  private async setVolume(level: number): Promise<CommandResult> {
    const clamped = Math.max(0, Math.min(100, level));
    const macVol = Math.round(clamped * 7 / 100); // macOS uses 0-7 scale
    await osascript(`set volume output volume ${clamped}`);
    return { success: true, message: `Volume set to ${clamped}%` };
  }

  private async adjustVolume(delta: number): Promise<CommandResult> {
    const current = await osascript('output volume of (get volume settings)');
    const currentVol = parseInt(current, 10) || 50;
    const newVol = Math.max(0, Math.min(100, currentVol + delta));
    await osascript(`set volume output volume ${newVol}`);
    return { success: true, message: `Volume ${delta > 0 ? 'up' : 'down'} → ${newVol}%` };
  }

  private async setMute(muted: boolean): Promise<CommandResult> {
    await osascript(`set volume output muted ${muted}`);
    return { success: true, message: muted ? 'Muted' : 'Unmuted' };
  }

  private async getVolume(): Promise<CommandResult> {
    const vol = await osascript('output volume of (get volume settings)');
    const muted = await osascript('output muted of (get volume settings)');
    return {
      success: true,
      message: `Volume: ${vol}%${muted === 'true' ? ' (muted)' : ''}`,
    };
  }

  // ── Brightness ──
  private async setBrightness(level: number): Promise<CommandResult> {
    const clamped = Math.max(0, Math.min(100, level));
    const fraction = (clamped / 100).toFixed(2);

    // Try brightness CLI tool first (brew install brightness)
    const toolCheck = await run('which brightness 2>/dev/null');
    if (toolCheck.exitCode === 0) {
      await run(`brightness ${fraction}`);
      return { success: true, message: `Brightness set to ${clamped}%` };
    }

    // Fallback: simulate brightness key presses to approximate level
    // Key code 107 = brightness down (F1), 113 = brightness up (F2)
    const steps = Math.round(clamped / 6.25); // macOS has ~16 brightness steps
    for (let i = 0; i < 16; i++) {
      await run('osascript -e \'tell application "System Events" to key code 107\'');
    }
    for (let i = 0; i < steps; i++) {
      await run('osascript -e \'tell application "System Events" to key code 113\'');
    }
    return { success: true, message: `Brightness set to ~${clamped}%` };
  }

  private async adjustBrightness(delta: number): Promise<CommandResult> {
    // Key code 113 = brightness up (F2), 107 = brightness down (F1)
    const keyCode = delta > 0 ? 113 : 107;
    const steps = Math.max(1, Math.abs(Math.round(delta * 16)));
    for (let i = 0; i < steps; i++) {
      await run(`osascript -e 'tell application "System Events" to key code ${keyCode}'`);
    }
    return { success: true, message: `Brightness ${delta > 0 ? 'increased' : 'decreased'}` };
  }

  // ── Dark Mode ──
  private async setDarkMode(on: boolean): Promise<CommandResult> {
    await osascript(
      `tell application "System Events" to tell appearance preferences to set dark mode to ${on}`
    );
    return { success: true, message: `Dark mode ${on ? 'enabled' : 'disabled'}` };
  }

  private async toggleDarkMode(): Promise<CommandResult> {
    const current = await osascript(
      'tell application "System Events" to tell appearance preferences to get dark mode'
    );
    const isOn = current.trim() === 'true';
    return this.setDarkMode(!isOn);
  }

  // ── Do Not Disturb ──
  private async setDnd(on: boolean): Promise<CommandResult> {
    // macOS Monterey+ uses Focus system. Toggle via shortcuts or defaults.
    if (on) {
      await run('shortcuts run "Turn On Focus" 2>/dev/null || defaults -currentHost write com.apple.notificationcenterui doNotDisturb -boolean true && killall NotificationCenter 2>/dev/null');
    } else {
      await run('shortcuts run "Turn Off Focus" 2>/dev/null || defaults -currentHost write com.apple.notificationcenterui doNotDisturb -boolean false && killall NotificationCenter 2>/dev/null');
    }
    return { success: true, message: `Do Not Disturb ${on ? 'enabled' : 'disabled'}` };
  }

  // ── Sleep / Lock ──
  private async sleepMac(): Promise<CommandResult> {
    await run('pmset sleepnow');
    return { success: true, message: 'Putting Mac to sleep...' };
  }

  private async lockScreen(): Promise<CommandResult> {
    await run('osascript -e \'tell application "System Events" to keystroke "q" using {command down, control down}\'');
    return { success: true, message: 'Screen locked' };
  }

  private async startScreensaver(): Promise<CommandResult> {
    await run('open -a ScreenSaverEngine');
    return { success: true, message: 'Screensaver started' };
  }

  // ── Trash ──
  private async emptyTrash(): Promise<CommandResult> {
    await osascript(
      'tell application "Finder" to empty trash'
    );
    return { success: true, message: 'Trash emptied' };
  }

  // ── Shutdown / Restart ──
  private async shutdown(): Promise<CommandResult> {
    await osascript('tell application "System Events" to shut down');
    return { success: true, message: 'Shutting down...' };
  }

  private async restart(): Promise<CommandResult> {
    await osascript('tell application "System Events" to restart');
    return { success: true, message: 'Restarting...' };
  }

  getHelp(): string {
    return [
      '  System Control — control your Mac',
      '    volume <0-100>   Set volume (e.g. "volume 50")',
      '    volume up/down   Adjust volume',
      '    mute / unmute    Toggle mute',
      '    volume           Show current volume',
      '    brightness <n>   Set brightness (e.g. "brightness 70")',
      '    brighter/dimmer  Adjust brightness',
      '    dark mode        Toggle dark mode',
      '    dark mode on     Enable dark mode',
      '    light mode       Disable dark mode',
      '    dnd on/off       Do Not Disturb toggle',
      '    sleep            Put Mac to sleep',
      '    lock             Lock screen',
      '    screensaver      Start screensaver',
      '    empty trash      Empty the Trash',
      '    shutdown         Shut down the Mac',
      '    restart          Restart the Mac',
    ].join('\n');
  }
}
