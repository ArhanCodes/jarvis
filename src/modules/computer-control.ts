import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { run } from '../utils/shell.js';
import { osascript } from '../utils/osascript.js';

export class ComputerControlModule implements JarvisModule {
  name = 'computer-control' as const;
  description = 'Direct mouse, keyboard, and screen control for macOS — click, type, hotkeys, scroll, screenshots, and window focus';

  private hasCliclick: boolean | null = null;

  private async checkCliclick(): Promise<boolean> {
    if (this.hasCliclick === null) {
      const result = await run('which cliclick 2>/dev/null');
      this.hasCliclick = result.exitCode === 0;
    }
    return this.hasCliclick;
  }

  patterns: PatternDefinition[] = [
    // ── Click ──
    {
      intent: 'click',
      patterns: [
        /^click\s+(?:at\s+)?(\d+)\s+(\d+)/i,
        /^click\s+(?:at\s+)?(\d+)[,\s]+(\d+)/i,
        /^left\s*click\s+(?:at\s+)?(\d+)\s+(\d+)/i,
      ],
      extract: (match) => ({ x: match[1], y: match[2] }),
    },
    // ── Double Click ──
    {
      intent: 'double-click',
      patterns: [
        /^double[\s-]?click\s+(?:at\s+)?(\d+)\s+(\d+)/i,
        /^double[\s-]?click\s+(?:at\s+)?(\d+)[,\s]+(\d+)/i,
      ],
      extract: (match) => ({ x: match[1], y: match[2] }),
    },
    // ── Right Click ──
    {
      intent: 'right-click',
      patterns: [
        /^right[\s-]?click\s+(?:at\s+)?(\d+)\s+(\d+)/i,
        /^right[\s-]?click\s+(?:at\s+)?(\d+)[,\s]+(\d+)/i,
      ],
      extract: (match) => ({ x: match[1], y: match[2] }),
    },
    // ── Type Text ──
    {
      intent: 'type',
      patterns: [
        /^type\s+(?:out\s+)?(.+)/i,
      ],
      extract: (match) => ({ text: match[1] }),
    },
    // ── Hotkey ──
    {
      intent: 'hotkey',
      patterns: [
        /^(?:hotkey|shortcut)\s+(.+)/i,
        /^(?:key\s+)?combo\s+(.+)/i,
      ],
      extract: (match) => ({ combo: match[1] }),
    },
    // ── Press Key ──
    {
      intent: 'press',
      patterns: [
        /^(?:press|hit)\s+(.+)/i,
      ],
      extract: (match) => ({ key: match[1] }),
    },
    // ── Scroll ──
    {
      intent: 'scroll',
      patterns: [
        /^scroll\s+(up|down)(?:\s+(\d+))?/i,
      ],
      extract: (match) => ({ direction: match[1], amount: match[2] || '3' }),
    },
    // ── Screenshot ──
    {
      intent: 'screenshot',
      patterns: [
        /^(?:take\s+(?:a\s+)?)?screenshot/i,
        /^(?:screen\s*cap(?:ture)?|snap\s+screen)/i,
        /^capture\s+(?:the\s+)?screen/i,
      ],
      extract: () => ({}),
    },
    // ── Move Mouse ──
    {
      intent: 'move',
      patterns: [
        /^move\s+(?:the\s+)?mouse\s+(?:to\s+)?(\d+)\s+(\d+)/i,
        /^move\s+(?:the\s+)?mouse\s+(?:to\s+)?(\d+)[,\s]+(\d+)/i,
        /^move\s+(?:to\s+)?(\d+)\s+(\d+)/i,
      ],
      extract: (match) => ({ x: match[1], y: match[2] }),
    },
    // ── Focus Window ──
    {
      intent: 'focus-window',
      patterns: [
        /^focus\s+(?:on\s+)?(.+)/i,
        /^switch\s+to\s+(.+)/i,
        /^(?:bring|activate)\s+(.+?)(?:\s+to\s+front)?$/i,
      ],
      extract: (match) => ({ app: match[1] }),
    },
    // ── Get Mouse Position ──
    {
      intent: 'get-mouse-position',
      patterns: [
        /^(?:where\s+is\s+(?:my\s+)?mouse|mouse\s+position|get\s+mouse\s+(?:pos(?:ition)?|location))/i,
        /^(?:cursor|pointer)\s+(?:position|location)/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'click': return this.click(parseInt(command.args.x), parseInt(command.args.y));
      case 'double-click': return this.doubleClick(parseInt(command.args.x), parseInt(command.args.y));
      case 'right-click': return this.rightClick(parseInt(command.args.x), parseInt(command.args.y));
      case 'type': return this.typeText(command.args.text);
      case 'hotkey': return this.hotkey(command.args.combo);
      case 'press': return this.pressKey(command.args.key);
      case 'scroll': return this.scroll(command.args.direction, parseInt(command.args.amount));
      case 'screenshot': return this.screenshot();
      case 'move': return this.moveMouse(parseInt(command.args.x), parseInt(command.args.y));
      case 'focus-window': return this.focusWindow(command.args.app);
      case 'get-mouse-position': return this.getMousePosition();
      default: return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  // ── Click ──
  private async click(x: number, y: number): Promise<CommandResult> {
    try {
      if (await this.checkCliclick()) {
        await run(`cliclick c:${x},${y}`);
      } else {
        await osascript(`tell application "System Events" to click at {${x}, ${y}}`);
      }
      return { success: true, message: `Clicked at (${x}, ${y})`, voiceMessage: `Clicked at ${x}, ${y}` };
    } catch (err) {
      return { success: false, message: `Click failed: ${(err as Error).message}` };
    }
  }

  // ── Double Click ──
  private async doubleClick(x: number, y: number): Promise<CommandResult> {
    try {
      if (await this.checkCliclick()) {
        await run(`cliclick dc:${x},${y}`);
      } else {
        // AppleScript double-click: move then click twice rapidly
        await osascript(`
tell application "System Events"
  click at {${x}, ${y}}
  delay 0.05
  click at {${x}, ${y}}
end tell`);
      }
      return { success: true, message: `Double-clicked at (${x}, ${y})`, voiceMessage: `Double clicked at ${x}, ${y}` };
    } catch (err) {
      return { success: false, message: `Double-click failed: ${(err as Error).message}` };
    }
  }

  // ── Right Click ──
  private async rightClick(x: number, y: number): Promise<CommandResult> {
    try {
      if (await this.checkCliclick()) {
        await run(`cliclick rc:${x},${y}`);
      } else {
        // Use Python to right-click since AppleScript click doesn't natively support right-click at coords
        await run(`osascript -e 'tell application "System Events"
  set p to {${x}, ${y}}
  do shell script "cliclick rc:${x},${y}"
end tell' 2>/dev/null || python3 -c "
import Quartz
point = Quartz.CGPointMake(${x}, ${y})
event = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventRightMouseDown, point, Quartz.kCGMouseButtonRight)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
import time; time.sleep(0.05)
event = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventRightMouseUp, point, Quartz.kCGMouseButtonRight)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
"`);
      }
      return { success: true, message: `Right-clicked at (${x}, ${y})`, voiceMessage: `Right clicked at ${x}, ${y}` };
    } catch (err) {
      return { success: false, message: `Right-click failed: ${(err as Error).message}` };
    }
  }

  // ── Type Text ──
  private async typeText(text: string): Promise<CommandResult> {
    try {
      const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      await osascript(`tell application "System Events" to keystroke "${escaped}"`);
      return { success: true, message: `Typed "${text}"`, voiceMessage: `Typed the text` };
    } catch (err) {
      return { success: false, message: `Type failed: ${(err as Error).message}` };
    }
  }

  // ── Hotkey ──
  private async hotkey(combo: string): Promise<CommandResult> {
    try {
      // Parse combo like "cmd+c", "cmd+shift+s", "ctrl+alt+delete"
      const parts = combo.toLowerCase().replace(/\s+/g, '').split('+');
      const key = parts.pop()!;
      const modifiers = parts.map(m => {
        if (m === 'cmd' || m === 'command') return 'command down';
        if (m === 'ctrl' || m === 'control') return 'control down';
        if (m === 'alt' || m === 'option' || m === 'opt') return 'option down';
        if (m === 'shift') return 'shift down';
        return '';
      }).filter(Boolean);

      // Check if the key is a special key that needs key code
      const keyCode = this.getKeyCode(key);
      if (keyCode !== null) {
        const using = modifiers.length > 0 ? ` using {${modifiers.join(', ')}}` : '';
        await osascript(`tell application "System Events" to key code ${keyCode}${using}`);
      } else {
        const using = modifiers.length > 0 ? ` using {${modifiers.join(', ')}}` : '';
        await osascript(`tell application "System Events" to keystroke "${key}"${using}`);
      }
      return { success: true, message: `Pressed ${combo}`, voiceMessage: `Pressed ${combo}` };
    } catch (err) {
      return { success: false, message: `Hotkey failed: ${(err as Error).message}` };
    }
  }

  // ── Press Key ──
  private async pressKey(key: string): Promise<CommandResult> {
    try {
      const keyLower = key.toLowerCase().trim();
      const keyCode = this.getKeyCode(keyLower);
      if (keyCode !== null) {
        await osascript(`tell application "System Events" to key code ${keyCode}`);
      } else {
        // Treat as a single character keystroke
        await osascript(`tell application "System Events" to keystroke "${key.replace(/"/g, '\\"')}"`);
      }
      return { success: true, message: `Pressed ${key}`, voiceMessage: `Pressed ${key}` };
    } catch (err) {
      return { success: false, message: `Key press failed: ${(err as Error).message}` };
    }
  }

  // ── Scroll ──
  private async scroll(direction: string, amount: number): Promise<CommandResult> {
    try {
      const dir = direction.toLowerCase();
      const scrollAmount = dir === 'up' ? amount : -amount;
      // Use Python + Quartz for reliable scrolling
      await run(`python3 -c "
import Quartz
event = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 1, ${scrollAmount})
Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
"`);
      return { success: true, message: `Scrolled ${dir} by ${amount}`, voiceMessage: `Scrolled ${dir}` };
    } catch (err) {
      // Fallback: use AppleScript key codes for arrow keys
      try {
        const keyCode = direction.toLowerCase() === 'up' ? 126 : 125;
        for (let i = 0; i < amount; i++) {
          await osascript(`tell application "System Events" to key code ${keyCode}`);
        }
        return { success: true, message: `Scrolled ${direction} by ${amount}` };
      } catch (fallbackErr) {
        return { success: false, message: `Scroll failed: ${(err as Error).message}` };
      }
    }
  }

  // ── Screenshot ──
  private async screenshot(): Promise<CommandResult> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filePath = `${process.env.HOME}/Desktop/screenshot-${timestamp}.png`;
      await run(`screencapture -x "${filePath}"`);
      return {
        success: true,
        message: `Screenshot saved to ${filePath}`,
        voiceMessage: 'Screenshot taken and saved to Desktop',
        data: { path: filePath },
      };
    } catch (err) {
      return { success: false, message: `Screenshot failed: ${(err as Error).message}` };
    }
  }

  // ── Move Mouse ──
  private async moveMouse(x: number, y: number): Promise<CommandResult> {
    try {
      if (await this.checkCliclick()) {
        await run(`cliclick m:${x},${y}`);
      } else {
        await run(`python3 -c "
import Quartz
point = Quartz.CGPointMake(${x}, ${y})
event = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, point, 0)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
"`);
      }
      return { success: true, message: `Mouse moved to (${x}, ${y})`, voiceMessage: `Mouse moved to ${x}, ${y}` };
    } catch (err) {
      return { success: false, message: `Mouse move failed: ${(err as Error).message}` };
    }
  }

  // ── Focus Window ──
  private async focusWindow(app: string): Promise<CommandResult> {
    try {
      const trimmed = app.trim().replace(/^["']|["']$/g, '');
      await osascript(`tell application "${trimmed}" to activate`);
      return { success: true, message: `Focused ${trimmed}`, voiceMessage: `Switched to ${trimmed}` };
    } catch (err) {
      return { success: false, message: `Focus failed: ${(err as Error).message}` };
    }
  }

  // ── Get Mouse Position ──
  private async getMousePosition(): Promise<CommandResult> {
    try {
      // Use Python + Quartz to get mouse location
      const result = await run(`python3 -c "
import Quartz
loc = Quartz.NSEvent.mouseLocation()
screen_h = Quartz.CGDisplayPixelsHigh(Quartz.CGMainDisplayID())
print(f'{int(loc.x)},{int(screen_h - loc.y)}')"
`);
      const pos = result.stdout.trim();
      const [x, y] = pos.split(',');
      return {
        success: true,
        message: `Mouse is at (${x}, ${y})`,
        voiceMessage: `Your mouse is at ${x}, ${y}`,
        data: { x: parseInt(x), y: parseInt(y) },
      };
    } catch (err) {
      // Fallback: try cliclick
      try {
        if (await this.checkCliclick()) {
          const result = await run('cliclick p');
          return { success: true, message: `Mouse position: ${result.stdout.trim()}`, data: { raw: result.stdout.trim() } };
        }
      } catch { /* fall through */ }
      return { success: false, message: `Could not get mouse position: ${(err as Error).message}` };
    }
  }

  // ── Key Code Map ──
  private getKeyCode(key: string): number | null {
    const codes: Record<string, number> = {
      'return': 36, 'enter': 36,
      'escape': 53, 'esc': 53,
      'tab': 48,
      'space': 49,
      'delete': 51, 'backspace': 51,
      'forward delete': 117, 'forwarddelete': 117,
      'up': 126, 'down': 125, 'left': 123, 'right': 124,
      'home': 115, 'end': 119,
      'pageup': 116, 'page up': 116,
      'pagedown': 121, 'page down': 121,
      'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118,
      'f5': 96, 'f6': 97, 'f7': 98, 'f8': 100,
      'f9': 101, 'f10': 109, 'f11': 103, 'f12': 111,
    };
    return codes[key] ?? null;
  }

  getHelp(): string {
    return [
      '  Computer Control — direct mouse & keyboard control',
      '    click <x> <y>           Left click at coordinates',
      '    double click <x> <y>    Double click at coordinates',
      '    right click <x> <y>     Right click at coordinates',
      '    type <text>             Type text via keyboard',
      '    hotkey <combo>          Press keyboard shortcut (e.g. cmd+c)',
      '    press <key>             Press a single key (enter, escape, tab...)',
      '    scroll up/down [n]      Scroll in direction (default 3 lines)',
      '    screenshot              Take screenshot to Desktop',
      '    move mouse to <x> <y>   Move mouse to coordinates',
      '    focus <app>             Bring app window to front',
      '    mouse position          Get current mouse position',
    ].join('\n');
  }
}
