import { captureScreenText } from './screen-awareness.js';
import { generate, isOllamaRunning } from '../utils/ollama.js';
import { getActiveModel } from './ai-chat.js';
import { fmt } from '../utils/formatter.js';

// ── Screen Watcher ──
// Background daemon that periodically captures the screen via OCR,
// maintains a running summary (general awareness), and proactively
// alerts the user about time-sensitive events (classes, meetings, deadlines).

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

    // Initial tick after 10s (let voice assistant settle)
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
    if (!this.stateChecker()) return; // voice assistant is busy

    try {
      const ollamaUp = await isOllamaRunning();
      if (!ollamaUp) return;
    } catch {
      return;
    }

    this.ticking = true;

    try {
      const newText = await captureScreenText();
      if (!newText || newText.length < 20) {
        this.ticking = false;
        return;
      }

      // Skip analysis if screen hasn't changed much
      if (this.lastOcrText && this.similarity(newText, this.lastOcrText) > 0.85) {
        this.ticking = false;
        return;
      }

      this.lastOcrText = newText;
      const truncated = newText.slice(0, 2000);
      const model = getActiveModel();

      // 1. Generate screen summary (general awareness)
      try {
        const summary = await generate(model,
          `Summarize what's on this screen in 1-2 sentences. Focus on: which app is open, what the user is working on, any visible times/dates/events.\n\nScreen content:\n${truncated}`
        );
        if (summary?.trim()) {
          this.lastScreenSummary = summary.trim();
        }
      } catch { /* non-critical */ }

      // Check state again before triage (may have become busy during summary)
      if (!this.stateChecker()) {
        this.ticking = false;
        return;
      }

      // 2. Time-sensitive triage
      try {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        const dayStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

        const triageResult = await generate(model,
          `Current time: ${timeStr}, ${dayStr}.

Below is raw OCR text from the user's screen.

--- SCREEN TEXT ---
${truncated}
--- END ---

Does the screen text contain a calendar event, class, or meeting with a START TIME between 15-30 minutes from now (${timeStr})?

RULES:
- You MUST be able to quote the exact event name AND exact start time from the text above
- The start time must be clearly a scheduled time (from a calendar, schedule, or agenda), NOT a timestamp on a message/notification
- Respond NONE if: no events found, text is ambiguous, event already happened, it's a confirmation/receipt/notification, or you're unsure
- NEVER invent or assume events. When in doubt: NONE

Format if found: ALERT: Sir, you have "[exact event name]" at [exact time from text].
Otherwise: NONE`
        );

        if (triageResult?.trim() && /^ALERT:/i.test(triageResult.trim())) {
          const alertText = triageResult.trim().replace(/^ALERT:\s*/i, '').trim();
          // Validate: alert must reference something actually in the OCR text
          if (alertText && !this.alertedRecently(alertText) && this.alertMatchesScreen(alertText, truncated)) {
            this.recordAlert(alertText);
            console.log(fmt.info(`[watch] ${alertText}`));
            // Speak proactively — callback handles state management
            await this.speakCallback(alertText);
          }
        }
      } catch { /* non-critical */ }
    } catch (err) {
      console.log(fmt.dim(`  [watch] Error: ${(err as Error).message}`));
    }

    this.ticking = false;
  }

  // ── Helpers ──

  /**
   * Jaccard similarity on word sets. Returns 0-1.
   */
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

  /**
   * Check if a similar alert was given recently (within 30 minutes).
   */
  private alertedRecently(alertText: string): boolean {
    const key = this.alertKey(alertText);
    const lastTime = this.alertHistory.get(key);
    if (!lastTime) return false;
    return Date.now() - lastTime < 30 * 60 * 1000; // 30 minutes
  }

  private recordAlert(alertText: string): void {
    this.alertHistory.set(this.alertKey(alertText), Date.now());

    // Clean up old alerts (> 2 hours)
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [key, ts] of this.alertHistory) {
      if (ts < cutoff) this.alertHistory.delete(key);
    }
  }

  /**
   * Normalize alert text to a dedup key — strip times/numbers so
   * "booking at 2:31 pm" and "booking at 2:02 pm" collapse to the same key.
   */
  private alertKey(text: string): string {
    return text
      .toLowerCase()
      .replace(/\d{1,2}:\d{2}\s*(am|pm)?/g, '')   // strip times like "2:31 pm"
      .replace(/\d{1,2}\s*(am|pm)/g, '')            // strip "2 pm"
      .replace(/\d+/g, '')                          // strip remaining numbers
      .replace(/[^a-z\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Validate that the alert actually references content from the screen.
   * Prevents hallucinated alerts by requiring:
   * 1. A time from the alert appears in the OCR text
   * 2. A multi-word phrase (3+ consecutive words) from the alert appears in the OCR
   */
  private alertMatchesScreen(alertText: string, ocrText: string): boolean {
    const ocrLower = ocrText.toLowerCase();
    const alertLower = alertText.toLowerCase();

    // 1. A time mentioned in the alert must exist in the OCR text
    const times = alertLower.match(/\d{1,2}:\d{2}\s*(am|pm)?|\d{1,2}\s*(am|pm)/g);
    if (!times || times.length === 0) return false; // no time = can't verify
    const timeInOcr = times.some(t => ocrLower.includes(t.trim()));
    if (!timeInOcr) return false;

    // 2. Extract the event name (text in quotes, or between "have" and "at")
    const quotedMatch = alertLower.match(/"([^"]+)"/);
    const haveAtMatch = alertLower.match(/have\s+(.+?)\s+at\s+\d/);
    const eventPhrase = quotedMatch?.[1] || haveAtMatch?.[1] || '';

    if (eventPhrase.length < 4) return false; // too short to verify

    // The event phrase (or a 3+ word substring) must appear in OCR
    if (ocrLower.includes(eventPhrase)) return true;

    // Try sliding window of 3 consecutive words from the event phrase
    const words = eventPhrase.split(/\s+/).filter(w => w.length >= 2);
    if (words.length >= 3) {
      for (let i = 0; i <= words.length - 3; i++) {
        const chunk = words.slice(i, i + 3).join(' ');
        if (ocrLower.includes(chunk)) return true;
      }
    }

    return false;
  }
}
