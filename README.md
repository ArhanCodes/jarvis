# J.A.R.V.I.S.

**Just A Rather Very Intelligent System**

A local macOS system automation engine built in TypeScript. Control your entire machine through natural language commands via CLI or voice. No AI, no cloud, no API keys — just smart pattern matching and native macOS scripting.

```
       ██╗ █████╗ ██████╗ ██╗   ██╗██╗███████╗
       ██║██╔══██╗██╔══██╗██║   ██║██║██╔════╝
       ██║███████║██████╔╝██║   ██║██║███████╗
  ██   ██║██╔══██║██╔══██╗╚██╗ ██╔╝██║╚════██║
  ╚█████╔╝██║  ██║██║  ██║ ╚████╔╝ ██║███████║
   ╚════╝ ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝
```

## Quick Start

```bash
# Clone / navigate to the project
cd ~/Downloads/jarvis

# Install dependencies
npm install

# Launch JARVIS
npm run dev
```

That's it. You'll see the `jarvis>` prompt. Start typing commands.

## What Can It Do?

### App Launcher

```
jarvis> open Safari
  ✓ Opened Safari

jarvis> close Slack
  ✓ Closed Slack

jarvis> switch to Chrome
  ✓ Switched to Chrome

jarvis> list apps
  ✓ Running applications:
    • Finder
    • Google Chrome
    • Safari
    • Terminal
```

### Script Runner

```
jarvis> $ git status
  ✓ On branch main, nothing to commit

jarvis> run ls -la
  ✓ (full directory listing)

jarvis> shell echo "hello world"
  ✓ hello world
```

Dangerous commands (`rm -rf /`, `sudo rm`, etc.) are automatically blocked.

### System Monitor

```
jarvis> cpu
  ✓ CPU: Apple M3
    Cores: 8
    Usage: 25.3% user, 21.4% sys, 53.3% idle

jarvis> battery
  ✓ Battery: 60%
    State: charging
    Remaining: 2:34

jarvis> status
  ─── JARVIS SYSTEM REPORT ───
  (full CPU + Memory + Disk + Battery + Network dashboard)
```

| Command | What it shows |
|---------|--------------|
| `cpu` | CPU model, cores, usage |
| `memory` / `ram` | Total, used, free RAM |
| `disk` / `space` | Disk usage and available space |
| `battery` | Charge %, state, time remaining |
| `network` / `ip` | Local IP, WiFi SSID |
| `status` | All of the above in one report |

### File Operations

```
jarvis> search package.json
  ✓ Found 5 result(s):
    /Users/you/project/package.json
    ...

jarvis> open folder ~/Downloads
  ✓ Opened /Users/you/Downloads in Finder

jarvis> move ~/Desktop/old.txt to ~/Archive/old.txt
  ✓ Moved /Users/you/Desktop/old.txt → /Users/you/Archive/old.txt

jarvis> delete ~/Desktop/junk.txt
  ✓ Moved to Trash: /Users/you/Desktop/junk.txt
```

File search uses **Spotlight** (`mdfind`) for instant results. Delete moves files to Trash (always recoverable).

| Command | What it does |
|---------|-------------|
| `search <name>` | Spotlight file search |
| `open folder <path>` | Open in Finder |
| `move <src> to <dest>` | Move file/folder |
| `copy <src> to <dest>` | Copy file/folder |
| `delete <path>` | Move to Trash |
| `ls <path>` | List directory |

### System Control

```
jarvis> volume 50
  ✓ Volume set to 50%

jarvis> mute
  ✓ Muted

jarvis> dark mode on
  ✓ Dark mode enabled

jarvis> lock
  ✓ Screen locked
```

| Command | What it does |
|---------|-------------|
| `volume <0-100>` | Set volume |
| `volume up` / `volume down` | Adjust by 10% |
| `volume` | Show current volume |
| `mute` / `unmute` | Toggle mute |
| `brightness <0-100>` | Set brightness |
| `brighter` / `dimmer` | Adjust brightness |
| `dark mode` / `dark mode on` / `light mode` | Toggle dark mode |
| `dnd on` / `dnd off` | Do Not Disturb |
| `sleep` | Put Mac to sleep |
| `lock` | Lock screen |
| `screensaver` | Start screensaver |
| `empty trash` | Empty the Trash |
| `shutdown` / `restart` | Power controls |

### Timers & Reminders

```
jarvis> timer 5 min
  ✓ Timer #1 set for 5m (fires at 3:45:00 PM)

jarvis> remind me in 1 hour to push code
  ✓ Reminder #1 set: "push code" in 1h (at 4:40:00 PM)

jarvis> alarm 7:00 am
  ✓ Alarm #1 set for 7:00:00 AM (in 9h 25m)

jarvis> timers
  ✓ Active timers:
    #1  Timer #1  —  4m 30s remaining
    #2  Reminder #1: push code  —  59m remaining

jarvis> stopwatch
  ✓ Stopwatch started! Type "stopwatch" again to stop.
```

When timers fire, you get a **macOS notification** with sound + a terminal alert.

Time formats supported: `30s`, `5 min`, `1h30m`, `2.5 hours`, `1:30`, or just a number (assumed minutes).

| Command | What it does |
|---------|-------------|
| `timer <duration>` | Set a countdown |
| `remind me in <time> to <message>` | Reminder with notification |
| `alarm <time>` | Set alarm (e.g. `7:00 am`) |
| `stopwatch` | Start/stop stopwatch |
| `timers` | List active timers |
| `cancel timer <#>` | Cancel specific timer |
| `cancel all timers` | Cancel everything |

### Voice Commands

```
jarvis> voice
  🎤 Voice mode activated — speak your commands!
  ℹ Say "stop listening" or press Ctrl+C to exit voice mode.

  🗣  Heard: "open Safari"
  ✓ Opened Safari

  🗣  Heard: "what's my battery"
  ✓ Battery: 60%
    State: charging

  🗣  Heard: "stop listening"
  ℹ Voice mode deactivated.
```

Voice uses Apple's **SFSpeechRecognizer** — the same on-device engine behind Siri. Fully local, free, no API keys.

On first use, JARVIS auto-compiles a small Swift helper binary (one-time ~5s). macOS will prompt for **Microphone** and **Speech Recognition** permissions.

**Requirements:** macOS 13+ with Xcode Command Line Tools (`xcode-select --install`).

## Aliases

Create shortcuts for frequently used commands:

```
jarvis> alias deploy = run npm run build && npm run deploy
  ✓ Alias created: "deploy" → "run npm run build && npm run deploy"

jarvis> deploy
  ✓ (runs the aliased command)

jarvis> aliases
  chrome: open Google Chrome
  safari: open Safari
  stats:  status
  vol:    volume
  dm:     dark mode
  ...
```

Built-in aliases: `chrome`, `safari`, `finder`, `terminal`, `code`, `stats`, `space`, `ip`, `apps`, `vol`, `dm`, `ss`, `nap`.

## Startup Commands

Auto-run commands every time JARVIS launches:

```
jarvis> startup add battery
  ✓ Startup command added: "battery"

jarvis> startup add volume
  ✓ Startup command added: "volume"

jarvis> startup list
  1. battery
  2. volume

jarvis> startup remove 1
  ✓ Removed startup command: "battery"

jarvis> startup clear
  ✓ Startup commands cleared.
```

Next time you run `npm run dev`, those commands execute automatically after the banner.

## Architecture

```
User Input → Alias Expansion → Regex Parser → Executor → Module → macOS Commands
                                                                        ↓
                                                          AppleScript / shell / Node.js os
```

**No AI/LLM** is used anywhere. The parser is a two-phase regex engine:

1. **Pattern matching** — each module declares regex patterns for its intents. First match wins. Confidence 1.0.
2. **Keyword fallback** — if no pattern matches, single keywords like `battery`, `mute`, `timers` are caught. Confidence 0.6.

### Project Structure

```
jarvis/
├── bin/jarvis.ts                  # Entry point
├── config/
│   ├── aliases.json               # User command shortcuts
│   └── startup.json               # Auto-run on boot
├── src/
│   ├── index.ts                   # REPL loop, wires everything together
│   ├── core/
│   │   ├── types.ts               # Shared interfaces
│   │   ├── parser.ts              # Natural language → ParsedCommand
│   │   ├── registry.ts            # Module registry
│   │   └── executor.ts            # Dispatches to modules
│   ├── modules/
│   │   ├── app-launcher.ts        # open, close, switch, list apps
│   │   ├── script-runner.ts       # run shell commands
│   │   ├── system-monitor.ts      # cpu, memory, disk, battery, network
│   │   ├── file-operations.ts     # search, move, copy, delete files
│   │   ├── system-control.ts      # volume, brightness, dark mode, sleep
│   │   └── timer.ts               # timers, reminders, alarms, stopwatch
│   ├── utils/
│   │   ├── shell.ts               # Safe child_process wrapper + deny-list
│   │   ├── osascript.ts           # AppleScript helpers
│   │   └── formatter.ts           # Chalk colored terminal output
│   └── voice/
│       └── voice-input.ts         # macOS Speech Recognition via Swift helper
├── package.json
└── tsconfig.json
```

### 6 Modules

| Module | File | Commands | macOS Tools Used |
|--------|------|----------|-----------------|
| App Launcher | `app-launcher.ts` | open, close, switch, list | `open -a`, `osascript` |
| Script Runner | `script-runner.ts` | run, $, shell, exec | `child_process.exec` |
| System Monitor | `system-monitor.ts` | cpu, memory, disk, battery, network, status | `top`, `os` module, `df`, `pmset`, `ifconfig` |
| File Operations | `file-operations.ts` | search, open folder, move, copy, delete, ls | `mdfind`, `mv`, `cp`, Finder trash |
| System Control | `system-control.ts` | volume, brightness, dark mode, dnd, sleep, lock | `osascript`, `pmset` |
| Timers | `timer.ts` | timer, remind, alarm, stopwatch | `setTimeout`, macOS notifications |

## Dependencies

**1 runtime dependency:**

- [`chalk`](https://github.com/chalk/chalk) — terminal colors

**Dev only:**

- `typescript` — compiler
- `tsx` — run .ts files directly in dev mode
- `@types/node` — Node.js type definitions

Everything else is Node.js built-ins (`readline`, `child_process`, `os`, `fs`) and macOS native tools (`osascript`, `mdfind`, `pmset`, `open`).

## Requirements

- **macOS** (tested on macOS 14 Sonoma, Apple Silicon)
- **Node.js 20+**
- **Xcode Command Line Tools** (for voice commands only): `xcode-select --install`

## Build & Install

```bash
# Development (uses tsx, no build step)
npm run dev

# Production build
npm run build
npm start

# Install globally (makes 'jarvis' available everywhere)
npm link
jarvis
```

## Adding Your Own Module

1. Create `src/modules/my-module.ts`:

```typescript
import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';

export class MyModule implements JarvisModule {
  name = 'my-module' as const;  // add to ModuleName type in types.ts
  description = 'Does cool things';

  patterns: PatternDefinition[] = [
    {
      intent: 'greet',
      patterns: [/^(?:hello|hi|hey)\s*(.*)/i],
      extract: (match) => ({ who: match[1] || 'world' }),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    return { success: true, message: `Hello, ${command.args.who}!` };
  }

  getHelp(): string {
    return '  My Module\n    hello <name>    Say hello';
  }
}
```

2. Add `'my-module'` to `ModuleName` in `src/core/types.ts`
3. Register in `src/index.ts`:

```typescript
import { MyModule } from './modules/my-module.js';
registry.register(new MyModule());
```

## License

MIT
