# J.A.R.V.I.S.

**Just A Rather Very Intelligent System**

A local macOS system automation engine built in TypeScript. Control your entire machine through natural language commands via CLI or voice + optional local AI via Ollama.

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
cd ~/Downloads/jarvis
npm install
npm run dev
```

---

## Features

| Category | Capabilities |
|----------|-------------|
| **14 modules** | Apps, scripts, system info, files, system control, timers, processes, clipboard, windows, media, workflows, AI chat, personality, smart assist |
| **Local AI chat** | Chat with Ollama models (Llama 3, Mistral, etc)  |
| **File AI** | Summarize or explain any file with local LLMs |
| **JARVIS personality** | Greetings, jokes, conversation, time-aware responses |
| **Smart suggestions** | NLU fallback, typo-tolerant suggestions, usage analytics |
| **Command chaining** | `battery && cpu && disk` — run multiple commands in sequence |
| **Fuzzy matching** | Typo tolerance via Levenshtein distance — `baterry` still works |
| **Variables** | `$HOME`, `$DATE`, `$TIME`, custom `$vars` |
| **Command history** | Persistent across sessions, searchable, `!!` to repeat last |
| **Aliases** | Create shortcuts for any command |
| **Workflows** | Multi-step automations saved and replayable |
| **Scheduling** | Cron-style recurring tasks (`every 5 min run battery`) |
| **Voice input** | On-device speech recognition via Apple SFSpeechRecognizer |
| **macOS Shortcuts** | Run and list Shortcuts.app shortcuts directly |
| **Startup commands** | Auto-run commands on launch |

---

## All Commands

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
    • Terminal
```

| Command | What it does |
|---------|-------------|
| `open <app>` | Launch an application |
| `close <app>` / `quit <app>` | Quit an application |
| `switch to <app>` | Bring app to front |
| `list apps` / `apps` | List running applications |

### Script Runner

```
jarvis> $ git status
  ✓ On branch main, nothing to commit

jarvis> run ls -la
  ✓ (full directory listing)
```

Dangerous commands (`rm -rf /`, `sudo rm`, `mkfs`, `dd`, `fork bombs`, `chmod 777`, etc.) are automatically blocked

| Command | What it does |
|---------|-------------|
| `$ <command>` | Run a shell command |
| `run <command>` / `exec <command>` | Run a shell command |
| `shell <command>` | Run a shell command |

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
| `cpu` / `processor` | CPU model, cores, usage |
| `memory` / `ram` | Total, used, free RAM |
| `disk` / `storage` / `space` | Disk usage and available space |
| `battery` | Charge %, state, time remaining |
| `network` / `wifi` / `ip` | Local IP, WiFi SSID |
| `status` | All of the above in one report |

### File Operations

```
jarvis> search package.json
  ✓ Found 5 result(s):
    /Users/you/project/package.json
    ...

jarvis> open folder ~/Downloads
  ✓ Opened /Users/you/Downloads in Finder

jarvis> delete ~/Desktop/junk.txt
  ✓ Moved to Trash: /Users/you/Desktop/junk.txt
```

File search uses Spotlight (`mdfind`) for instant results. Delete moves files to Trash

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

jarvis> dark mode on
  ✓ Dark mode enabled

jarvis> lock
  ✓ Screen locked
```

| Command | What it does |
|---------|-------------|
| `volume <0-100>` | Set volume |
| `volume up` / `volume down` | Adjust by 10% |
| `mute` / `unmute` | Toggle mute |
| `brightness <0-100>` | Set brightness |
| `brighter` / `dimmer` | Adjust brightness |
| `dark mode` / `light mode` | Toggle dark mode |
| `dnd on` / `dnd off` | Do Not Disturb |
| `sleep` / `lock` | Sleep or lock screen |
| `screensaver` | Start screensaver |
| `empty trash` | Empty the Trash |
| `shutdown` / `restart` | Power controls |

### Timers & Reminders

```
jarvis> timer 5 min
  ✓ Timer #1 set for 5m (fires at 3:45:00 PM)

jarvis> remind me in 1 hour to push code
  ✓ Reminder #1 set: "push code" in 1h (at 4:40:00 PM)

jarvis> stopwatch
  ✓ Stopwatch started! Type "stopwatch" again to stop.
```

When timers fire, you get a **macOS notification** with sound + a terminal alert.

Time formats: `30s`, `5 min`, `1h30m`, `2.5 hours`, `1:30`, or just a bare number (assumed minutes).

| Command | What it does |
|---------|-------------|
| `timer <duration>` | Set a countdown |
| `remind me in <time> to <msg>` | Reminder with notification |
| `alarm <time>` | Set alarm (e.g. `7:00 am`) |
| `stopwatch` | Start/stop stopwatch |
| `timers` | List active timers |
| `cancel timer <#>` | Cancel specific timer |
| `cancel all timers` | Cancel everything |

### Process Manager

```
jarvis> top cpu
  ✓ Top CPU processes:
    1. Google Chrome Helper  — 45.2%
    2. node                  — 12.1%
    ...

jarvis> port 3000
  ✓ Port 3000: node (PID 12345)

jarvis> kill node
  ✓ Killed process: node
```

| Command | What it does |
|---------|-------------|
| `top cpu` / `top memory` | Show top resource consumers |
| `kill <name>` | Kill a process by name |
| `kill pid <pid>` | Kill a process by PID |
| `port <number>` | Show what's using a port |
| `kill port <number>` | Kill process on a port |
| `find process <name>` | Search for a running process |
| `ps` | List all foreground processes |

### Clipboard Manager

```
jarvis> paste
  ✓ Clipboard: (current clipboard contents)

jarvis> clips
  ✓ Clipboard history:
    #1  Hello world
    #2  npm install
    ...

jarvis> paste #2
  ✓ Pasted from history: npm install
```

| Command | What it does |
|---------|-------------|
| `copy <text>` | Copy text to clipboard |
| `paste` / `clipboard` | Show current clipboard |
| `clips` / `clip history` | Show clipboard history (last 50) |
| `paste #<n>` | Paste from history by index |
| `clip search <query>` | Search clipboard history |
| `clip clear` | Clear clipboard history |

### Window Manager

```
jarvis> tile Safari left
  ✓ Tiled Safari to left

jarvis> tile Chrome right
  ✓ Tiled Chrome to right

jarvis> Safari and Chrome side by side
  ✓ Arranged Safari and Chrome side by side

jarvis> fullscreen Terminal
  ✓ Maximized Terminal
```

| Command | What it does |
|---------|-------------|
| `tile <app> left/right` | Tile to half of screen |
| `tile <app> top/bottom` | Tile to top/bottom half |
| `fullscreen <app>` / `maximize <app>` | Maximize window |
| `center <app>` | Center window on screen |
| `resize <app> 800x600` | Resize to dimensions |
| `minimize <app>` | Minimize all windows |
| `<app> and <app> side by side` | Arrange two apps side by side |
| `windows` | List all open windows |

### Media Control (Spotify & Apple Music)

```
jarvis> play
  ✓ Playing (Spotify)

jarvis> now playing
  ✓ ▶ Bohemian Rhapsody
    by Queen
    on A Night at the Opera

jarvis> next
  ✓ ▶ Don't Stop Me Now
    by Queen
    on Jazz

jarvis> play "Daft Punk"
  ✓ Searching Spotify for "Daft Punk"
```

Auto detects whether Spotify or Apple Music is running.

| Command | What it does |
|---------|-------------|
| `play` / `resume` | Start/resume playback |
| `pause` | Pause playback |
| `next` / `skip` | Next track |
| `prev` / `back` | Previous track |
| `play/pause` | Toggle play/pause |
| `now playing` / `np` | Show current track |
| `play <song/artist>` | Search and play on Spotify |
| `playlist <name>` | Play a playlist |
| `shuffle` / `shuffle off` | Toggle shuffle |
| `repeat` | Toggle repeat |

### Workflows & Automation

```
jarvis> create workflow morning: battery && cpu && volume 30
  ✓ Workflow "morning" created with 3 step(s):
    1. battery
    2. cpu
    3. volume 30

jarvis> workflow morning
  Running workflow "morning" (3 steps)...
  [1/3] battery
  ✓ Battery: 85%, State: charged
  [2/3] cpu
  ✓ CPU: Apple M3, ...
  [3/3] volume 30
  ✓ Volume set to 30%
  Workflow "morning" complete: 3/3 steps succeeded

jarvis> every 5 min run battery
  ✓ Scheduled #1: "battery" every 5m

jarvis> shortcut "Toggle Dark Mode"
  ✓ Shortcut "Toggle Dark Mode" executed
```

| Command | What it does |
|---------|-------------|
| `create workflow <name>: step1 && step2` | Create a workflow |
| `workflow <name>` | Run a saved workflow |
| `workflows` | List all workflows |
| `delete workflow <name>` | Delete a workflow |
| `shortcut <name>` | Run a macOS Shortcut |
| `shortcuts` | List macOS Shortcuts |
| `every <interval> run <cmd>` | Schedule a recurring command |
| `scheduled` / `cron` | List scheduled tasks |
| `cancel scheduled <#>` | Cancel a scheduled task |

### AI Chat

```
jarvis> ask what is recursion
  [llama3]
  Recursion is a programming technique where a function calls itself
  to solve a problem by breaking it down into smaller subproblems...

jarvis> summarize ~/code/main.py
  [llama3] Processing /Users/you/code/main.py...
  This file implements a REST API server with 3 endpoints...

jarvis> explain package.json
  [llama3] Processing package.json...
  This is a Node.js project configuration file...

jarvis> models
  ✓ Available models:
    llama3:latest (4.7 GB) <-- active
    mistral:latest (4.1 GB)
    codellama:latest (3.8 GB)

jarvis> use model mistral
  ✓ Switched to model "mistral". Conversation cleared.
```

Requires [Ollama](https://ollama.com) installed and running (`ollama serve`). If Ollama isn't installed, all other features still work normally

| Command | What it does |
|---------|-------------|
| `ask <question>` / `ai <prompt>` | Chat with local AI |
| `summarize <file or topic>` | Summarize a file or topic |
| `explain <file or topic>` | Explain code or a concept |
| `models` | List installed Ollama models |
| `use model <name>` | Switch active model |
| `clear chat` / `new conversation` | Reset conversation history |
| `ai status` | Check Ollama connection |

### JARVIS Personality

```
jarvis> hello
  ✓ Good morning, sir. All systems operational. How may I assist you?

jarvis> tell me a joke
  ✓ Why do programmers prefer dark mode? Because light attracts bugs.

jarvis> how are you
  ✓ Running smoothly, sir. 42 commands processed over the last 15 minutes.
    All systems nominal.

jarvis> who are you
  ✓ I'm JARVIS -- Just A Rather Very Intelligent System. I have 14 modules
    loaded and can manage your apps, files, system, media, workflows, and more.
```


| Command | What it does |
|---------|-------------|
| `hello` / `hey` / `good morning` | Time-aware greeting |
| `who are you` / `what can you do` | Self-introduction |
| `tell me a joke` | Random tech joke |
| `how are you` | System-aware mood check |
| `what time is it` / `what day is it` | Current time/date |
| `thanks` / `sorry` | Conversational responses |

### Smart Assist

```
jarvis> show me heaviest processes
  ✓ (automatically maps to "top cpu" via NLU)

jarvis> blargify the foobar
  ⚠ I didn't understand "blargify the foobar". Did you mean:
    - open <app>
    - search <name>
    - ask <question>

jarvis> what can I do
  ✓ Try something new:
    - cpu
    - open <app>
    - timer <duration>
    - play / pause
    - ask <question>

jarvis> top commands
  ✓ Your most used commands:
    1. battery (15x)
    2. cpu (12x)
    3. volume 50 (8x)
```

| Command | What it does |
|---------|-------------|
| `what can I do` / `suggestions` | Context aware command suggestions |
| `top commands` / `frequent commands` | Most used command analytics |
| *(automatic)* | NLU fallback for natural language phrases |
| *(automatic)* | Smart suggestions when commands aren't recognized |

---

## Command Chaining

Run multiple commands in sequence with `&&` or `;`:

```
jarvis> battery && cpu && disk
  ✓ Battery: 85% ...
  ✓ CPU: Apple M3 ...
  ✓ Disk: 45% used ...

jarvis> open Safari; open Chrome; tile Safari left; tile Chrome right
```

## Variables

Built-in variables expand automatically:

```
jarvis> $ echo $HOME
  ✓ /Users/you

jarvis> $ echo $DATE
  ✓ 2026-02-22

jarvis> set mydir = ~/Projects
  ✓ Variable $mydir set

jarvis> open folder $mydir
  ✓ Opened /Users/you/Projects in Finder
```

| Variable | Value |
|----------|-------|
| `$HOME` | Home directory |
| `$USER` | Username |
| `$DATE` | Today's date (YYYY-MM-DD) |
| `$TIME` | Current time (HH:MM:SS) |
| `$NOW` | Full timestamp |
| `$PWD` | Current directory |
| `$UPTIME` | Session uptime |

## Command History

Persistent across sessions, stored in `config/history.json`:

```
jarvis> history
  Recent commands:
    1. battery
    2. volume 50
    3. open Safari
    ...

jarvis> !!
  (repeats last command)

jarvis> history search volume
  Matches: volume 50, volume up, ...
```

| Command | What it does |
|---------|-------------|
| `history` | Show recent commands |
| `history <n>` | Show last n commands |
| `!!` | Repeat last command |
| `history search <query>` | Search command history |
| `history clear` | Clear all history |

## Aliases

Create shortcuts for frequently used commands:

```
jarvis> alias deploy = run npm run build && npm run deploy
  ✓ Alias created: "deploy" → "run npm run build && npm run deploy"

jarvis> deploy
  (runs the aliased command)

jarvis> aliases
  chrome → open Google Chrome
  safari → open Safari
  stats  → status
  vol    → volume
  ...

jarvis> delete alias deploy
  ✓ Alias "deploy" deleted
```

Built-in aliases: `chrome`, `safari`, `finder`, `terminal`, `code`, `stats`, `space`, `ip`, `apps`, `vol`, `dm`, `ss`, `nap`.

## Voice Commands

```
jarvis> voice
  🎤 Voice mode activated — speak your commands!
  ℹ Say "stop listening" or press Ctrl+C to exit voice mode.

  🗣  Heard: "open Safari"
  ✓ Opened Safari

  🗣  Heard: "what's my battery"
  ✓ Battery: 60%

  🗣  Heard: "stop listening"
  ℹ Voice mode deactivated.
```

Uses Apple's **SFSpeechRecognizer** — fully on-device, free, no API keys. On first use, JARVIS auto-compiles a small Swift helper binary (one-time ~5s). macOS will prompt for **Microphone** and **Speech Recognition** permissions.

**Requires:** macOS 13+ with Xcode Command Line Tools (`xcode-select --install`).

## Startup Commands

Auto-run commands every time JARVIS launches:

```
jarvis> startup add battery
jarvis> startup add volume
jarvis> startup list
  1. battery
  2. volume
jarvis> startup remove 1
jarvis> startup clear
```

## Fuzzy Matching & Typo Tolerance

JARVIS uses Levenshtein distance to handle typos. If your input is within an edit distance of 2 from a known keyword, it still works:

```
jarvis> baterry
  ✓ Battery: 85% ...

jarvis> neetwork
  ✓ Network: 192.168.1.5, WiFi: MyNetwork
```

---

## Architecture

```
User Input → Variable Expansion → Alias Expansion → Pattern Parser → Executor → Module
                                                          ↓                        ↓
                                                    Keyword Fallback    AppleScript / shell / Ollama
                                                          ↓
                                                    Fuzzy Match (Levenshtein)
                                                          ↓
                                                    NLU Mapping (natural language)
                                                          ↓
                                                    Smart Suggestions (if nothing matches)
```

The core parser uses **no AI/LLM** — it's a seven-phase engine:

1. **Variable expansion** — `$HOME`, `$DATE`, custom `$vars`
2. **Alias expansion** — user-defined shortcuts
3. **"open" disambiguation** — detects if target is app or file path
4. **Regex pattern matching** — each module declares regex patterns; first match wins (confidence 1.0)
5. **Keyword fallback** — exact keyword match (confidence 0.6), then Levenshtein fuzzy match (confidence 0.4)
6. **NLU mapping** — natural language phrases mapped to existing commands (confidence 0.5)
7. **Smart suggestions** — if nothing matches, suggest closest commands

AI features (Ollama chat, summarize, explain) are optional — they use locally-running LLMs with zero cloud/API dependencies

### Project Structure

```
jarvis/
├── bin/jarvis.ts                  # Entry point
├── config/
│   ├── aliases.json               # User command shortcuts
│   ├── startup.json               # Auto-run on boot
│   ├── workflows.json             # Saved workflows
│   └── history.json               # Command history (auto-generated)
├── src/
│   ├── index.ts                   # REPL loop, wires everything together
│   ├── core/
│   │   ├── types.ts               # Shared interfaces (14 module types)
│   │   ├── parser.ts              # 7-phase NL parser + fuzzy matching
│   │   ├── registry.ts            # Module registry
│   │   ├── executor.ts            # Dispatches to modules
│   │   ├── history.ts             # Persistent command history
│   │   └── context.ts             # Session state + variable expansion
│   ├── modules/
│   │   ├── app-launcher.ts        # open, close, switch, list apps
│   │   ├── script-runner.ts       # run shell commands (with deny-list)
│   │   ├── system-monitor.ts      # cpu, memory, disk, battery, network
│   │   ├── file-operations.ts     # search, move, copy, delete files
│   │   ├── system-control.ts      # volume, brightness, dark mode, sleep
│   │   ├── timer.ts               # timers, reminders, alarms, stopwatch
│   │   ├── process-manager.ts     # kill, top processes, port lookup
│   │   ├── clipboard.ts           # copy, paste, clipboard history
│   │   ├── window-manager.ts      # tile, resize, fullscreen, arrange
│   │   ├── media-control.ts       # Spotify & Apple Music control
│   │   ├── workflow.ts            # workflows, Shortcuts, scheduling
│   │   ├── personality.ts         # greetings, jokes, conversation
│   │   ├── ai-chat.ts            # Ollama LLM chat, summarize, explain
│   │   └── smart-assist.ts       # NLU mapping, suggestions, analytics
│   ├── utils/
│   │   ├── shell.ts               # Safe child_process wrapper + deny-list
│   │   ├── osascript.ts           # AppleScript helpers
│   │   ├── formatter.ts           # Chalk colored terminal output
│   │   └── ollama.ts              # Ollama HTTP client (streaming)
│   └── voice/
│       └── voice-input.ts         # macOS Speech Recognition via Swift
├── package.json
└── tsconfig.json
```

### 14 Modules

| Module | File | Key Commands | Tools Used |
|--------|------|-------------|------------|
| App Launcher | `app-launcher.ts` | open, close, switch, list apps | `open -a`, `osascript` |
| Script Runner | `script-runner.ts` | `$`, run, exec, shell | `child_process.exec` |
| System Monitor | `system-monitor.ts` | cpu, memory, disk, battery, network | `top`, `os`, `df`, `pmset`, `ifconfig` |
| File Operations | `file-operations.ts` | search, move, copy, delete, ls | `mdfind`, `mv`, `cp`, Finder trash |
| System Control | `system-control.ts` | volume, brightness, dark mode, sleep | `osascript`, key codes |
| Timers | `timer.ts` | timer, remind, alarm, stopwatch | `setTimeout`, notifications |
| Process Manager | `process-manager.ts` | kill, top, port, find process | `ps`, `kill`, `lsof`, `pgrep` |
| Clipboard | `clipboard.ts` | copy, paste, clip history | `pbcopy`, `pbpaste` |
| Window Manager | `window-manager.ts` | tile, fullscreen, center, resize | `osascript` (System Events) |
| Media Control | `media-control.ts` | play, pause, skip, now playing | `osascript` (Spotify/Music) |
| Workflows | `workflow.ts` | workflow, shortcut, schedule | parser re-entry, `shortcuts` CLI |
| Personality | `personality.ts` | hello, joke, how are you, time | Local response tables |
| AI Chat | `ai-chat.ts` | ask, summarize, explain, models | Ollama REST API (`fetch`) |
| Smart Assist | `smart-assist.ts` | suggestions, top commands, NLU | Levenshtein, history analysis |

## Dependencies

**1 runtime dependency:**

- [`chalk`](https://github.com/chalk/chalk) — terminal colors

**Dev only:**

- `typescript` — compiler
- `tsx` — run .ts files directly in dev
- `@types/node` — Node.js type definitions

Everything else is Node.js built-ins (`readline`, `child_process`, `os`, `fs`) and macOS native tools (`osascript`, `mdfind`, `pmset`, `open`, `pbcopy`/`pbpaste`, `lsof`, `shortcuts`).

## Requirements

- **macOS** (tested on macOS 14 Sonoma, Apple Silicon)
- **Node.js 20+**
- **Xcode Command Line Tools** (for voice commands only): `xcode-select --install`
- **Ollama** (optional, for AI features only): [ollama.com](https://ollama.com) — run `ollama serve` then `ollama pull llama3`

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
  name = 'my-module' as const;  // add to ModuleName in types.ts
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
