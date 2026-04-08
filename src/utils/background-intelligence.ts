/**
 * Background Intelligence — Always-on JARVIS features
 *
 * Runs automatically when JARVIS boots. No activation needed.
 *
 * 1. Context Awareness — detects app switches, prints contextual suggestions
 * 2. Autonomous Alerts — battery warnings, time-based reminders
 * 3. Habit Learning — tracks command patterns, suggests automations
 */

import { fmt } from './formatter.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──

const MONITOR_INTERVAL = 2 * 60 * 1000; // 2 minutes
const HABIT_THRESHOLD = 3; // suggest automation after 3+ repeats

// ── Types ──

interface Habit {
  command: string;
  hour: number;
  dayOfWeek: number; // 0=Sun, 6=Sat
  occurrences: number;
  lastSeen: string;
  automated: boolean;
}

interface HabitStore {
  habits: Habit[];
  commandLog: { cmd: string; time: string }[];
  lastUpdated: string;
}

// ── App Context Suggestions ──

const APP_CONTEXT: Record<string, string[]> = {
  'Spotify': ['Now playing info? (now playing)', 'Skip track? (next)', 'Pause? (pause)'],
  'Music': ['Now playing? (now playing)', 'Skip? (next)', 'Pause? (pause)'],
  'Visual Studio Code': ['Check git status? ($ git status)', 'Run tests? ($ npm test)', 'Build project? ($ npm run build)'],
  'Code': ['Check git status? ($ git status)', 'Run tests? ($ npm test)', 'Build project? ($ npm run build)'],
  'Xcode': ['Build project? ($ xcodebuild)', 'Run tests? ($ xcodebuild test)'],
  'Safari': ['Read this page? (read this page)', 'Screenshot? (screenshot)', 'Search something? (search <query>)'],
  'Google Chrome': ['Read this page? (read this page)', 'Screenshot? (screenshot)', 'Search? (search <query>)'],
  'Slack': ['Mute notifications? (dnd on)'],
  'Microsoft Teams': ['Mute notifications? (dnd on)'],
  'Finder': ['Search for files? (search <name>)', 'Open Downloads? (open folder ~/Downloads)'],
  'Terminal': ['Check processes? (top cpu)', 'Git status? ($ git status)'],
  'Notes': ['Search notes?'],
};

// ── State ──

let monitorTimer: NodeJS.Timeout | null = null;
let lastFrontApp = '';
let lastBatteryAlert = 0;
let lastTimeAlert = 0;

// ── Persistence ──

function getConfigPath(filename: string): string {
  const paths = [
    join(__dirname, '..', '..', 'config', filename),
    join(__dirname, '..', 'config', filename),
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  const dir = dirname(paths[0]);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return paths[0];
}

function loadHabits(): HabitStore {
  try {
    const path = getConfigPath('habits.json');
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      if (!Array.isArray(data.habits)) data.habits = [];
      if (!Array.isArray(data.commandLog)) data.commandLog = [];
      if (!data.lastUpdated) data.lastUpdated = new Date().toISOString();
      return data;
    }
  } catch { /* fresh */ }
  return { habits: [], commandLog: [], lastUpdated: new Date().toISOString() };
}

function saveHabits(store: HabitStore): void {
  try {
    writeFileSync(getConfigPath('habits.json'), JSON.stringify(store, null, 2));
  } catch { /* skip */ }
}

// ── Proactive Monitor (runs every 2 min) ──

async function runProactiveMonitor(): Promise<void> {
  const alerts: string[] = [];

  // 1. CONTEXT AWARENESS — detect app switches
  try {
    const { stdout } = await execAsync(
      `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`,
      { timeout: 3000 },
    );
    const currentApp = stdout.trim();
    if (currentApp && currentApp !== lastFrontApp && lastFrontApp !== '') {
      const suggestions = APP_CONTEXT[currentApp];
      if (suggestions) {
        alerts.push(`Switched to ${currentApp}:`);
        for (const s of suggestions.slice(0, 2)) {
          alerts.push(`  → ${s}`);
        }
      }
    }
    if (currentApp) lastFrontApp = currentApp;
  } catch { /* skip */ }

  // 2. AUTONOMOUS ALERTS — battery
  const now = Date.now();
  if (now - lastBatteryAlert > 10 * 60 * 1000) {
    try {
      const { stdout } = await execAsync(
        `pmset -g batt | grep -Eo '\\d+%' | head -1`,
        { timeout: 3000 },
      );
      const pct = parseInt(stdout.trim().replace('%', ''), 10);
      if (!isNaN(pct) && pct <= 15) {
        alerts.push(`⚡ Battery at ${pct}% — plug in now!`);
        lastBatteryAlert = now;
      } else if (!isNaN(pct) && pct <= 25) {
        alerts.push(`Battery at ${pct}% — consider plugging in soon.`);
        lastBatteryAlert = now;
      }
    } catch { /* skip */ }
  }

  // 2. AUTONOMOUS ALERTS — time
  const hour = new Date().getHours();
  if (now - lastTimeAlert > 30 * 60 * 1000) {
    if (hour === 23 || hour === 0) {
      alerts.push('It\'s getting late. Consider wrapping up. Say "good night" when ready.');
      lastTimeAlert = now;
    }
  }

  // 3. HABIT PREDICTIONS — suggest based on patterns
  const store = loadHabits();
  const day = new Date().getDay();
  const predictable = store.habits.filter(
    h => h.hour === hour && h.dayOfWeek === day && h.occurrences >= HABIT_THRESHOLD && !h.automated,
  );
  for (const habit of predictable.slice(0, 2)) {
    alerts.push(`You usually run "${habit.command}" around now. Want me to run it?`);
  }

  // Print alerts
  if (alerts.length > 0) {
    console.log('');
    for (const alert of alerts) {
      console.log(fmt.info(`  ${alert}`));
    }
    console.log('');
  }
}

// ── Public API ──

/**
 * Start background intelligence. Called once when JARVIS boots.
 */
export function startBackgroundIntelligence(): void {
  // Run first check after 30 seconds
  setTimeout(() => {
    runProactiveMonitor().catch(() => {});
  }, 30_000);

  monitorTimer = setInterval(() => {
    runProactiveMonitor().catch(() => {});
  }, MONITOR_INTERVAL);

  console.log(fmt.dim('  [jarvis] Background intelligence active'));
}

/**
 * Stop background intelligence.
 */
export function stopBackgroundIntelligence(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

/**
 * Record a command for habit learning. Called from index.ts after every command.
 */
export function learnCommand(cmd: string): void {
  const store = loadHabits();
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();

  // Log it
  store.commandLog.push({ cmd, time: now.toISOString() });
  if (store.commandLog.length > 500) {
    store.commandLog = store.commandLog.slice(-500);
  }

  // Find or create habit entry
  const existing = store.habits.find(
    h => h.command === cmd && h.hour === hour && h.dayOfWeek === day,
  );

  if (existing) {
    existing.occurrences++;
    existing.lastSeen = now.toISOString();
  } else {
    store.habits.push({
      command: cmd,
      hour,
      dayOfWeek: day,
      occurrences: 1,
      lastSeen: now.toISOString(),
      automated: false,
    });
  }

  store.lastUpdated = now.toISOString();
  saveHabits(store);

  // Check if any habit is ready to suggest
  const mature = store.habits.find(
    h => h.command === cmd && h.occurrences === HABIT_THRESHOLD && !h.automated,
  );
  if (mature) {
    const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][mature.dayOfWeek];
    console.log('');
    console.log(fmt.info(`Pattern detected: you run "${cmd}" around ${mature.hour}:00 on ${dayName}s (${mature.occurrences}x).`));
    console.log(fmt.dim(`  Create a scheduled task? → every ${dayName} at ${mature.hour}:00 run ${cmd}`));
    console.log('');
  }
}
