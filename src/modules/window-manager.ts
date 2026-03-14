import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { osascript } from '../utils/osascript.js';
import { run } from '../utils/shell.js';

export class WindowManagerModule implements JarvisModule {
  name = 'window-manager' as const;
  description = 'Tile, resize, move, fullscreen, and arrange windows';

  patterns: PatternDefinition[] = [
    {
      intent: 'tile-left',
      patterns: [
        /^tile\s+(.+?)\s+(?:to\s+)?(?:the\s+)?left/i,
        /^snap\s+(.+?)\s+left/i,
        /^(?:move\s+)?(.+?)\s+to\s+(?:the\s+)?left(?:\s+half)?/i,
      ],
      extract: (match) => ({ app: match[1].trim() }),
    },
    {
      intent: 'tile-right',
      patterns: [
        /^tile\s+(.+?)\s+(?:to\s+)?(?:the\s+)?right/i,
        /^snap\s+(.+?)\s+right/i,
        /^(?:move\s+)?(.+?)\s+to\s+(?:the\s+)?right(?:\s+half)?/i,
      ],
      extract: (match) => ({ app: match[1].trim() }),
    },
    {
      intent: 'tile-top',
      patterns: [
        /^tile\s+(.+?)\s+(?:to\s+)?(?:the\s+)?top/i,
        /^snap\s+(.+?)\s+top/i,
      ],
      extract: (match) => ({ app: match[1].trim() }),
    },
    {
      intent: 'tile-bottom',
      patterns: [
        /^tile\s+(.+?)\s+(?:to\s+)?(?:the\s+)?bottom/i,
        /^snap\s+(.+?)\s+bottom/i,
      ],
      extract: (match) => ({ app: match[1].trim() }),
    },
    {
      intent: 'fullscreen',
      patterns: [
        /^(?:full\s*screen|maximize)\s+(.+)/i,
        /^(?:make\s+)?(.+?)\s+full\s*screen/i,
        /^max(?:imize)?\s+(.+)/i,
      ],
      extract: (match) => ({ app: match[1].trim() }),
    },
    {
      intent: 'center',
      patterns: [
        /^center\s+(.+)/i,
        /^(?:move\s+)?(.+?)\s+to\s+(?:the\s+)?center/i,
      ],
      extract: (match) => ({ app: match[1].trim() }),
    },
    {
      intent: 'resize',
      patterns: [
        /^resize\s+(.+?)\s+(?:to\s+)?(\d+)\s*x\s*(\d+)/i,
        /^(?:set\s+)?(.+?)\s+(?:size|window)\s+(?:to\s+)?(\d+)\s*x\s*(\d+)/i,
      ],
      extract: (match) => ({ app: match[1].trim(), width: match[2], height: match[3] }),
    },
    {
      intent: 'minimize',
      patterns: [
        /^minimize\s+(.+)/i,
        /^hide\s+(.+)/i,
      ],
      extract: (match) => ({ app: match[1].trim() }),
    },
    {
      intent: 'arrange-side-by-side',
      patterns: [
        /^(?:arrange|put|tile)\s+(.+?)\s+(?:and|&)\s+(.+?)\s+side\s+by\s+side/i,
        /^side\s+by\s+side\s+(.+?)\s+(?:and|&)\s+(.+)/i,
      ],
      extract: (match) => ({ app1: match[1].trim(), app2: match[2].trim() }),
    },
    {
      intent: 'list-windows',
      patterns: [
        /^(?:list|show)\s+(?:all\s+)?windows/i,
        /^windows$/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'tile-left': return this.tileWindow(command.args.app, 'left');
      case 'tile-right': return this.tileWindow(command.args.app, 'right');
      case 'tile-top': return this.tileWindow(command.args.app, 'top');
      case 'tile-bottom': return this.tileWindow(command.args.app, 'bottom');
      case 'fullscreen': return this.fullscreen(command.args.app);
      case 'center': return this.centerWindow(command.args.app);
      case 'resize': return this.resizeWindow(command.args.app, parseInt(command.args.width), parseInt(command.args.height));
      case 'minimize': return this.minimizeWindow(command.args.app);
      case 'arrange-side-by-side': return this.sideBySide(command.args.app1, command.args.app2);
      case 'list-windows': return this.listWindows();
      default: return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  private async getScreenSize(): Promise<{ width: number; height: number }> {
    const result = await osascript(
      'tell application "Finder" to get bounds of window of desktop'
    ).catch(() => null);

    if (result) {
      const parts = result.split(', ').map(Number);
      if (parts.length === 4) {
        return { width: parts[2], height: parts[3] };
      }
    }

    // Fallback via system_profiler
    const spResult = await run("system_profiler SPDisplaysDataType 2>/dev/null | grep Resolution | head -1");
    const resMatch = spResult.stdout.match(/(\d+)\s*x\s*(\d+)/);
    if (resMatch) {
      return { width: parseInt(resMatch[1]), height: parseInt(resMatch[2]) };
    }

    return { width: 1920, height: 1080 }; // fallback
  }

  private async tileWindow(app: string, side: 'left' | 'right' | 'top' | 'bottom'): Promise<CommandResult> {
    const screen = await this.getScreenSize();
    const menuBar = 25; // macOS menu bar height
    let x = 0, y = menuBar, w = screen.width, h = screen.height - menuBar;

    switch (side) {
      case 'left': w = Math.floor(screen.width / 2); break;
      case 'right': x = Math.floor(screen.width / 2); w = Math.floor(screen.width / 2); break;
      case 'top': h = Math.floor((screen.height - menuBar) / 2); break;
      case 'bottom': y = menuBar + Math.floor((screen.height - menuBar) / 2); h = Math.floor((screen.height - menuBar) / 2); break;
    }

    try {
      await osascript(
        `tell application "${app}" to activate\n` +
        `tell application "System Events" to tell process "${app}"\n` +
        `  set position of window 1 to {${x}, ${y}}\n` +
        `  set size of window 1 to {${w}, ${h}}\n` +
        `end tell`
      );
      return { success: true, message: `Tiled ${app} to ${side}` };
    } catch {
      return { success: false, message: `Could not tile "${app}". Is it running?` };
    }
  }

  private async fullscreen(app: string): Promise<CommandResult> {
    const screen = await this.getScreenSize();
    try {
      await osascript(
        `tell application "${app}" to activate\n` +
        `tell application "System Events" to tell process "${app}"\n` +
        `  set position of window 1 to {0, 25}\n` +
        `  set size of window 1 to {${screen.width}, ${screen.height - 25}}\n` +
        `end tell`
      );
      return { success: true, message: `Maximized ${app}` };
    } catch {
      return { success: false, message: `Could not maximize "${app}". Is it running?` };
    }
  }

  private async centerWindow(app: string): Promise<CommandResult> {
    const screen = await this.getScreenSize();
    try {
      const sizeStr = await osascript(
        `tell application "System Events" to tell process "${app}" to get size of window 1`
      );
      const [w, h] = sizeStr.split(', ').map(Number);
      const x = Math.floor((screen.width - w) / 2);
      const y = Math.floor((screen.height - h) / 2);

      await osascript(
        `tell application "System Events" to tell process "${app}" to set position of window 1 to {${x}, ${y}}`
      );
      return { success: true, message: `Centered ${app}` };
    } catch {
      return { success: false, message: `Could not center "${app}". Is it running?` };
    }
  }

  private async resizeWindow(app: string, width: number, height: number): Promise<CommandResult> {
    try {
      await osascript(
        `tell application "System Events" to tell process "${app}" to set size of window 1 to {${width}, ${height}}`
      );
      return { success: true, message: `Resized ${app} to ${width}x${height}` };
    } catch {
      return { success: false, message: `Could not resize "${app}". Is it running?` };
    }
  }

  private async minimizeWindow(app: string): Promise<CommandResult> {
    try {
      await osascript(
        `tell application "${app}"\n  set miniaturized of every window to true\nend tell`
      );
      return { success: true, message: `Minimized ${app}` };
    } catch {
      return { success: false, message: `Could not minimize "${app}". Is it running?` };
    }
  }

  private async sideBySide(app1: string, app2: string): Promise<CommandResult> {
    const screen = await this.getScreenSize();
    const halfW = Math.floor(screen.width / 2);
    const h = screen.height - 25;

    try {
      await osascript(
        `tell application "${app1}" to activate\n` +
        `tell application "System Events" to tell process "${app1}"\n` +
        `  set position of window 1 to {0, 25}\n` +
        `  set size of window 1 to {${halfW}, ${h}}\n` +
        `end tell`
      );
      await osascript(
        `tell application "${app2}" to activate\n` +
        `tell application "System Events" to tell process "${app2}"\n` +
        `  set position of window 1 to {${halfW}, 25}\n` +
        `  set size of window 1 to {${halfW}, ${h}}\n` +
        `end tell`
      );
      return { success: true, message: `Arranged ${app1} and ${app2} side by side` };
    } catch {
      return { success: false, message: `Could not arrange windows. Are both apps running?` };
    }
  }

  private async listWindows(): Promise<CommandResult> {
    try {
      const result = await osascript(
        'tell application "System Events" to get {name, title of window 1} of every process whose background only is false and (count of windows) > 0'
      );
      // Parse the nested list
      const lines = result.split(', ').map(s => `    ${s.trim()}`);
      return { success: true, message: `Open windows:\n${lines.join('\n')}` };
    } catch {
      // Fallback to simpler approach
      const result = await osascript(
        'tell application "System Events" to get name of every process whose background only is false'
      );
      const apps = result.split(', ').map(s => `    ${s.trim()}`);
      return { success: true, message: `Apps with windows:\n${apps.join('\n')}` };
    }
  }

  getHelp(): string {
    return [
      '  Window Manager — arrange and control windows',
      '    tile <app> left/right        Tile window to half of screen',
      '    tile <app> top/bottom        Tile window to top/bottom half',
      '    fullscreen <app>             Maximize window',
      '    center <app>                 Center window on screen',
      '    resize <app> 800x600        Resize window to specific dimensions',
      '    minimize <app>               Minimize all windows of app',
      '    <app> and <app> side by side Arrange two apps side by side',
      '    windows                      List all open windows',
    ].join('\n');
  }
}
