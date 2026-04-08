import { captureScreenText } from './screen-awareness.js';
import { generate, isOllamaRunning } from '../utils/ollama.js';
import { getActiveModel } from './ai-chat.js';
import { fmt } from '../utils/formatter.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ── Screen Watcher ──
// Background daemon that:
// 1. Reads upcoming events from Apple Calendar & Reminders
// 2. Reads notes from Apple Notes app
// 3. Alerts the user ONLY about real upcoming calendar events or due reminders
// 4. Maintains screen context for conversation engine (silent — never speaks OCR)

export class ScreenWatcher {
  private lastOcrText = '';
  private lastScreenSummary = '';
  private alertHistory = new Map<string, number>(); // alert key → timestamp
  private interval: ReturnType<typeof setInterval> | null = null;
  private active = false;
  private stateChecker: () => boolean = () => true;
  private speakCallback: (text: string) => Promise<void> = async () => {};
  private tickIntervalMs = 60_000; // 60 seconds
  private ticking = false;

  start(
    stateChecker: () => boolean,
    speakCallback: (text: string) => Promise<void>,
  ): void {
    if (this.active) return;
    this.stateChecker = stateChecker;
    this.speakCallback = speakCallback;
    this.active = true;

    console.log(fmt.dim('  [watch] Screen monitoring active'));

    // Initial tick after 10s
    setTimeout(() => {
      if (this.active) this.tick();
    }, 10_000);

    this.interval = setInterval(() => this.tick(), this.tickIntervalMs);
  }

  stop(): void {
    this.active = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    console.log(fmt.dim('  [watch] Screen monitoring stopped'));
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Returns the latest screen context for the conversation engine.
   * Always available — no fresh capture needed.
   */
  getScreenContext(): string {
    if (!this.lastScreenSummary && !this.lastOcrText) return '';
    const parts: string[] = [];
    if (this.lastScreenSummary) parts.push(`Summary: ${this.lastScreenSummary}`);
    if (this.lastOcrText) parts.push(`Raw text: ${this.lastOcrText.slice(0, 2000)}`);
    return parts.join('\n\n');
  }

  // ── Core Loop ──

  private async tick(): Promise<void> {
    if (!this.active || this.ticking) return;
    if (!this.stateChecker()) return;

    this.ticking = true;

    try {
      // 1. Silent screen context update (for conversation engine, NEVER spoken)
      await this.updateScreenContext();

      // 2. Check Calendar & Reminders for upcoming events (this is what gets spoken)
      await this.checkUpcomingEvents();
    } catch (err) {
      console.log(fmt.dim(`  [watch] Error: ${(err as Error).message}`));
    }

    this.ticking = false;
  }

  /**
   * Silently update screen context — used by conversation engine when user asks
   * "what's on my screen?" but NEVER spoken proactively.
   */
  private async updateScreenContext(): Promise<void> {
    try {
      const newText = await captureScreenText();
      if (!newText || newText.length < 20) return;

      // Skip if screen hasn't changed
      if (this.lastOcrText && this.similarity(newText, this.lastOcrText) > 0.85) return;

      this.lastOcrText = newText;

      // Generate summary only if Ollama is up
      const ollamaUp = await isOllamaRunning();
      if (ollamaUp) {
        const model = getActiveModel();
        const summary = await generate(model,
          `Summarize what's on this screen in 1-2 sentences. Focus on: which app is open, what the user is working on.\n\nScreen content:\n${newText.slice(0, 2000)}`
        );
        if (summary?.trim()) this.lastScreenSummary = summary.trim();
      }
    } catch { /* non-critical — screen context is optional */ }
  }

  /**
   * Check Apple Notes for upcoming events/tasks written by the user.
   * Uses Ollama to parse natural language notes and find things happening soon.
   * Only alerts about events that haven't happened yet.
   */
  private async checkUpcomingEvents(): Promise<void> {
    if (!this.stateChecker()) return;

    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const dayStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const alerts: string[] = [];

    // ── Read recent notes from Apple Notes ──
    let notesContent = '';
    try {
      const notesScript = [
        'tell application "Notes"',
        '  set noteList to ""',
        '  set noteCount to 0',
        '  repeat with n in notes of default account',
        '    if noteCount >= 15 then exit repeat',
        '    set noteList to noteList & name of n & ": " & plaintext of n & "\\n---\\n"',
        '    set noteCount to noteCount + 1',
        '  end repeat',
        '  return noteList',
        'end tell',
      ];
      const cmd = notesScript.map(l => `-e '${l.replace(/'/g, "'\\''")}'`).join(' ');
      const { stdout } = await execAsync(`osascript ${cmd}`, { timeout: 15000 });
      notesContent = stdout.trim();
    } catch { /* Notes might not be accessible */ }

    if (!notesContent || notesContent.length < 10) {
      return; // No notes to check
    }

    // ── Pre-filter: extract only TODAY's section from notes ──
    // Notes have headers like "Thursday 19th March:" — only keep today's block
    const todayDate = now.getDate();
    const todayDay = now.toLocaleDateString('en-US', { weekday: 'long' });
    const todayMonth = now.toLocaleDateString('en-US', { month: 'long' });

    // Try to find today's section in the notes
    let todayNotes = '';
    const dayPatterns = [
      // "Thursday 19th March:" or "Friday 20th March:"
      new RegExp(`${todayDay}\\s+${todayDate}(?:st|nd|rd|th)?\\s+${todayMonth}[:\\s]`, 'i'),
      // "19th March" or "20 March"
      new RegExp(`${todayDate}(?:st|nd|rd|th)?\\s+${todayMonth}`, 'i'),
      // "March 19" or "March 20"
      new RegExp(`${todayMonth}\\s+${todayDate}(?:st|nd|rd|th)?`, 'i'),
    ];

    for (const pattern of dayPatterns) {
      const match = notesContent.match(pattern);
      if (match) {
        // Extract from this header to the next day header or end
        const startIdx = match.index!;
        // Find next day header (Monday/Tuesday/etc followed by date)
        const nextDayMatch = notesContent.slice(startIdx + match[0].length)
          .match(/\n\s*(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+\d/i);
        const endIdx = nextDayMatch
          ? startIdx + match[0].length + nextDayMatch.index!
          : Math.min(startIdx + 1500, notesContent.length);
        todayNotes = notesContent.slice(startIdx, endIdx);
        break;
      }
    }

    // If we couldn't find today's section, skip — don't risk reading wrong days
    if (!todayNotes || todayNotes.length < 5) {
      return;
    }

    // Remove checked-off / completed items (lines with ✅ or ✓ prefix)
    const filteredLines = todayNotes.split('\n').filter(line => {
      const trimmed = line.trim();
      return !trimmed.startsWith('✅') && !trimmed.startsWith('✓') && !trimmed.startsWith('☑');
    });
    const filteredNotes = filteredLines.join('\n');

    if (!filteredNotes.trim()) return;

    // ── Use Ollama to find upcoming events in today's notes ──
    try {
      const ollamaUp = await isOllamaRunning();
      if (!ollamaUp) return;

      const model = getActiveModel();

      const triageResult = await generate(model,
        `Current time: ${timeStr}. Today is ${dayStr}.

Below are ONLY today's uncompleted items from the user's notes:

--- TODAY'S NOTES ---
${filteredNotes.slice(0, 2000)}
--- END ---

Find items that have an EXPLICIT START TIME in parentheses (e.g. "(10:30-1)", "(8-8:30)", "(4:15-4:45)").

RULES:
- ONLY report items with a time in parentheses — ignore items without times
- The START time must be AFTER the current time ${timeStr} — if it already passed, SKIP IT
- The start time must be within the next 30 minutes from ${timeStr}
- NEVER report items from other days — this list is already filtered to today only
- If no items match, respond with exactly: NONE

Format: ALERT: Sir, you have "[event name]" at [start time].
If nothing: NONE`
      );

      if (triageResult?.trim() && triageResult.trim() !== 'NONE') {
        const lines = triageResult.trim().split('\n');
        for (const line of lines) {
          if (/^ALERT:/i.test(line.trim())) {
            const alertText = line.trim().replace(/^ALERT:\s*/i, '').trim();
            if (alertText && this.alertMatchesNotes(alertText, notesContent)) {
              alerts.push(alertText);
            }
          }
        }
      }
    } catch { /* non-critical */ }

    // ── Speak only new, non-duplicate alerts ──
    for (const alert of alerts) {
      if (!this.alertedRecently(alert)) {
        this.recordAlert(alert);
        console.log(fmt.info(`[watch] ${alert}`));
        await this.speakCallback(alert);
      }
    }
  }

  // ── Helpers ──

  private similarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length >= 3));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length >= 3));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++;
    }

    const union = new Set([...wordsA, ...wordsB]).size;
    return intersection / union;
  }

  private alertedRecently(alertText: string): boolean {
    const key = this.alertKey(alertText);
    const lastTime = this.alertHistory.get(key);
    if (!lastTime) return false;
    // Don't re-alert for the same event for 3 hours
    return Date.now() - lastTime < 3 * 60 * 60 * 1000;
  }

  private recordAlert(alertText: string): void {
    this.alertHistory.set(this.alertKey(alertText), Date.now());

    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    for (const [key, ts] of this.alertHistory) {
      if (ts < cutoff) this.alertHistory.delete(key);
    }
  }

  private alertKey(text: string): string {
    // Extract just the event name from quotes to avoid Ollama phrasing variations
    const quoted = text.match(/"([^"]+)"/);
    if (quoted) {
      // Just the event name, lowercased, stripped of times/parens
      return quoted[1]
        .toLowerCase()
        .replace(/\(.*?\)/g, '')
        .replace(/\d{1,2}:\d{2}/g, '')
        .replace(/[^a-z\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
    // Fallback: strip everything but letters
    return text
      .toLowerCase()
      .replace(/\d{1,2}:\d{2}\s*(am|pm)?/g, '')
      .replace(/\d{1,2}\s*(am|pm)/g, '')
      .replace(/\d+/g, '')
      .replace(/[^a-z\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Validate that the alert references content actually in the notes.
   * Prevents hallucinated alerts.
   */
  private alertMatchesNotes(alertText: string, notesContent: string): boolean {
    const notesLower = notesContent.toLowerCase();
    const alertLower = alertText.toLowerCase();

    // Extract the event name from quotes
    const quotedMatch = alertLower.match(/"([^"]+)"/);
    const haveAtMatch = alertLower.match(/have\s+(.+?)\s+at\s+\d/);
    const eventPhrase = quotedMatch?.[1] || haveAtMatch?.[1] || '';

    if (eventPhrase.length < 3) return false;

    // The event phrase must appear in the notes
    if (notesLower.includes(eventPhrase)) return true;

    // Try 2+ consecutive words from the event phrase
    const words = eventPhrase.split(/\s+/).filter(w => w.length >= 2);
    if (words.length >= 2) {
      for (let i = 0; i <= words.length - 2; i++) {
        const chunk = words.slice(i, i + 2).join(' ');
        if (notesLower.includes(chunk)) return true;
      }
    }

    return false;
  }
}
