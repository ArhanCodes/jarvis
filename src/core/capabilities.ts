// ── Module Capability Manifest ──
// Compact description of all JARVIS capabilities for the LLM system prompt.
// The LLM uses this to decide which [ACTION: ...] to emit.

interface Capability {
  module: string;
  action: string;
  description: string;
  example: string;
  args: string;
}

const CAPABILITIES: Capability[] = [
  // App Launcher
  { module: 'app-launcher', action: 'open', description: 'Open/launch a macOS desktop app (NOT for websites — use browser-control.browse for URLs)', example: 'open Chrome', args: 'app="Chrome"' },
  { module: 'app-launcher', action: 'close', description: 'Quit an app', example: 'close Safari', args: 'app="Safari"' },
  { module: 'app-launcher', action: 'switch', description: 'Switch to an app', example: 'switch to Slack', args: 'app="Slack"' },
  { module: 'app-launcher', action: 'list', description: 'List running apps', example: 'list apps', args: '' },

  // System Monitor
  { module: 'system-monitor', action: 'cpu', description: 'Show CPU usage', example: 'cpu', args: '' },
  { module: 'system-monitor', action: 'memory', description: 'Show RAM usage', example: 'memory', args: '' },
  { module: 'system-monitor', action: 'disk', description: 'Show disk space', example: 'disk', args: '' },
  { module: 'system-monitor', action: 'battery', description: 'Show battery level', example: 'battery', args: '' },
  { module: 'system-monitor', action: 'network', description: 'Show network/IP info', example: 'network', args: '' },
  { module: 'system-monitor', action: 'status', description: 'Full system status report', example: 'status', args: '' },

  // System Control
  { module: 'system-control', action: 'volume', description: 'Set volume 0-100', example: 'volume 50', args: 'level="50"' },
  { module: 'system-control', action: 'volume-up', description: 'Increase volume by 10', example: 'volume up', args: '' },
  { module: 'system-control', action: 'volume-down', description: 'Decrease volume by 10', example: 'volume down', args: '' },
  { module: 'system-control', action: 'mute', description: 'Mute system audio', example: 'mute', args: '' },
  { module: 'system-control', action: 'unmute', description: 'Unmute system audio', example: 'unmute', args: '' },
  { module: 'system-control', action: 'brightness', description: 'Set brightness 0-100', example: 'brightness 80', args: 'level="80"' },
  { module: 'system-control', action: 'dark-mode', description: 'Toggle dark/light mode', example: 'dark mode', args: '' },
  { module: 'system-control', action: 'sleep', description: 'Put computer to sleep', example: 'sleep', args: '' },
  { module: 'system-control', action: 'lock', description: 'Lock the screen', example: 'lock', args: '' },
  { module: 'system-control', action: 'screenshot', description: 'Take a screenshot', example: 'screenshot', args: '' },

  // File Operations
  { module: 'file-ops', action: 'search', description: 'Search for files by name', example: 'search readme', args: 'query="readme"' },
  { module: 'file-ops', action: 'open-folder', description: 'Open a folder in Finder', example: 'open folder ~/Desktop', args: 'path="~/Desktop"' },
  { module: 'file-ops', action: 'move', description: 'Move/rename a file', example: 'move old.txt to new.txt', args: 'src="old.txt" dest="new.txt"' },
  { module: 'file-ops', action: 'copy', description: 'Copy a file', example: 'copy a.txt to b.txt', args: 'src="a.txt" dest="b.txt"' },
  { module: 'file-ops', action: 'delete', description: 'Delete a file (trash)', example: 'delete temp.txt', args: 'path="temp.txt"' },

  // Timer
  { module: 'timer', action: 'timer', description: 'Set a countdown timer', example: 'timer 5 minutes', args: 'duration="5 minutes"' },
  { module: 'timer', action: 'remind', description: 'Set a reminder', example: 'remind me in 10 min to call mom', args: 'time="10 min" message="call mom"' },
  { module: 'timer', action: 'alarm', description: 'Set an alarm', example: 'alarm 7:30am', args: 'time="7:30am"' },

  // Process Manager
  { module: 'process-manager', action: 'top-cpu', description: 'Show top CPU-consuming processes', example: 'top cpu', args: '' },
  { module: 'process-manager', action: 'top-memory', description: 'Show top RAM-consuming processes', example: 'top memory', args: '' },
  { module: 'process-manager', action: 'kill', description: 'Kill a process by name', example: 'kill node', args: 'name="node"' },
  { module: 'process-manager', action: 'port', description: 'Show process on a port', example: 'port 3000', args: 'port="3000"' },

  // Clipboard
  { module: 'clipboard', action: 'copy', description: 'Copy text to clipboard', example: 'copy hello world', args: 'text="hello world"' },
  { module: 'clipboard', action: 'paste', description: 'Show clipboard contents', example: 'paste', args: '' },

  // Window Manager
  { module: 'window-manager', action: 'tile-left', description: 'Tile app to left half', example: 'tile Chrome left', args: 'app="Chrome"' },
  { module: 'window-manager', action: 'tile-right', description: 'Tile app to right half', example: 'tile Slack right', args: 'app="Slack"' },
  { module: 'window-manager', action: 'fullscreen', description: 'Make app fullscreen', example: 'fullscreen Chrome', args: 'app="Chrome"' },
  { module: 'window-manager', action: 'center', description: 'Center app window', example: 'center Terminal', args: 'app="Terminal"' },

  // Media Control
  { module: 'media-control', action: 'play', description: 'Play/resume media', example: 'play', args: '' },
  { module: 'media-control', action: 'pause', description: 'Pause media', example: 'pause', args: '' },
  { module: 'media-control', action: 'next', description: 'Skip to next track', example: 'next', args: '' },
  { module: 'media-control', action: 'now-playing', description: 'Show current track', example: 'now playing', args: '' },

  // Workflow
  { module: 'workflow', action: 'run-shortcut', description: 'Run a macOS Shortcut', example: 'shortcut Focus Mode', args: 'name="Focus Mode"' },

  // Scheduler
  { module: 'scheduler', action: 'create-task', description: 'Schedule a recurring command', example: 'every 20 min run check battery', args: 'interval="every 20 min" command="check battery"' },
  { module: 'scheduler', action: 'list-tasks', description: 'List scheduled tasks', example: 'scheduled', args: '' },
  { module: 'scheduler', action: 'cancel-task', description: 'Cancel a scheduled task', example: 'cancel scheduled 1', args: 'id="1"' },

  // Weather & News
  { module: 'weather-news', action: 'weather', description: 'Get current weather', example: 'weather', args: '' },
  { module: 'weather-news', action: 'weather-city', description: 'Get weather for a city', example: 'weather in London', args: 'city="London"' },
  { module: 'weather-news', action: 'news', description: 'Get top news headlines', example: 'news', args: '' },

  // Smart Routines
  { module: 'smart-routines', action: 'morning', description: 'Run morning routine', example: 'good morning', args: '' },
  { module: 'smart-routines', action: 'night', description: 'Run night routine', example: 'good night', args: '' },

  // Screen Awareness
  { module: 'screen-awareness', action: 'read-screen', description: 'OCR - read text on screen', example: 'read screen', args: '' },
  { module: 'screen-awareness', action: 'summarize-screen', description: 'Summarize what\'s on screen', example: 'summarize screen', args: '' },

  // WhatsApp
  { module: 'whatsapp', action: 'send', description: 'Send a WhatsApp message', example: 'message mom hello', args: 'contact="mom" message="hello"' },
  { module: 'whatsapp', action: 'read', description: 'Check recent WhatsApp messages', example: 'read whatsapp', args: '' },
  { module: 'whatsapp', action: 'login', description: 'Connect WhatsApp (QR scan)', example: 'whatsapp login', args: '' },

  // Browser Control — use for ALL website/URL tasks
  { module: 'browser-control', action: 'browse', description: 'Navigate to a website URL (use this for ANY website visit)', example: 'browse tradebuddy.com', args: 'url="tradebuddy.com"' },
  { module: 'browser-control', action: 'google', description: 'Google search', example: 'google quantum computing', args: 'query="quantum computing"' },
  { module: 'browser-control', action: 'read-page', description: 'Read/extract text from the current web page (use AFTER browse to actually read the site)', example: 'read page', args: '' },
  { module: 'browser-control', action: 'click', description: 'Click element on page', example: 'click "Sign In"', args: 'target="Sign In"' },
  { module: 'browser-control', action: 'screenshot', description: 'Screenshot the browser page', example: 'screenshot', args: '' },

  // Script Runner
  { module: 'script-runner', action: 'run', description: 'Run a shell command', example: '$ ls -la', args: 'command="ls -la"' },

  // Research
  { module: 'research', action: 'research', description: 'Research a topic (academic papers)', example: 'research quantum computing', args: 'topic="quantum computing"' },

  // Conversions
  { module: 'conversions', action: 'timezone', description: 'Convert time between timezones', example: '6 PM IST to GST', args: 'time="6 PM" from="IST" to="GST"' },
  { module: 'conversions', action: 'unit', description: 'Convert units (length, weight, volume, temperature, speed)', example: '10 miles to km', args: 'value="10" from="miles" to="km"' },

  // Site Monitor
  { module: 'site-monitor', action: 'check-all', description: 'Check if all sites and apps are online', example: 'site status', args: '' },
  { module: 'site-monitor', action: 'check-one', description: 'Check if a specific site/app is online', example: 'is Trade Buddy online', args: 'site="Trade Buddy"' },
];

export function buildCapabilityPrompt(): string {
  const lines = ['[JARVIS CAPABILITIES - respond with [ACTION: module.action(args)] to execute]'];
  for (const cap of CAPABILITIES) {
    const argStr = cap.args ? ` Args: ${cap.args}` : '';
    lines.push(`- ${cap.module}.${cap.action}: ${cap.description}.${argStr}`);
  }
  lines.push('');
  lines.push('');
  lines.push('IMPORTANT RULES:');
  lines.push('- For ANY website/URL, use browser-control.browse — NEVER use app-launcher.open for websites');
  lines.push('- To see what is on a website, you MUST browse it first, then read-page — do NOT make up content');
  lines.push('');
  lines.push('MULTI-STEP TASKS:');
  lines.push('When the user asks for a multi-step task, execute ONE step at a time using a single action tag.');
  lines.push('After your action runs, you will receive the result and can continue with the next step.');
  lines.push('Examples:');
  lines.push('- "browse tradebuddy.com and tell me what you think" → first [ACTION: browser-control.browse(url="tradebuddy.com")], then [ACTION: browser-control.read-page()], then give your opinion based on the ACTUAL page content');
  lines.push('- "research quantum computing and message mom about it" → first [ACTION: research.research(topic="quantum computing")], then use the result to [ACTION: whatsapp.send(...)]');
  return lines.join('\n');
}

export function getCapabilities(): Capability[] {
  return CAPABILITIES;
}
