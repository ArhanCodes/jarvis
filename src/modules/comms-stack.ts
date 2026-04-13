import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { getBrowser, isOpen } from '../utils/browser-manager.js';
import { llmStreamChat } from '../utils/llm.js';
import { fmt } from '../utils/formatter.js';
import { speak, isVoiceEnabled } from '../utils/voice-output.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('comms-stack');

// ── Comms Stack ──
// Checks specific WhatsApp chats for unread messages and prioritizes them.

const PROFILE = 'whatsapp';
const WA_URL = 'https://web.whatsapp.com';

// Chats to monitor — add or remove as needed
const MONITORED_CHATS = [
  'Arhan Harchandani Fall 2027 <> AE',
  "Arhan Harchandani's College Counseling Group",
  'STUDIH GROUP',
  '$elf Glazers',
  'mom',
];

interface UnreadChat {
  name: string;
  unreadCount: string;
  lastMessage: string;
}

export class CommsStackModule implements JarvisModule {
  name = 'comms-stack' as const;
  description = 'Unified communications priority queue';

  patterns: PatternDefinition[] = [
    {
      intent: 'comms',
      patterns: [
        /^(?:what\s+needs\s+my\s+attention|what(?:'s|\s+is)\s+urgent)$/i,
        /^(?:comms?\s*(?:stack|check)?|priority\s*(?:queue|messages?))$/i,
        /^check\s+(?:all\s+)?messages?$/i,
        /^(?:any\s+(?:new\s+)?messages?|unread\s+(?:messages?|comms?)|inbox\s+(?:check|status|summary))$/i,
        /^(?:brief\s+me\s+on\s+(?:my\s+)?(?:messages?|comms?|inbox))$/i,
        /^(?:catch\s+me\s+up|what\s+did\s+i\s+miss)$/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(_command: ParsedCommand): Promise<CommandResult> {
    return this.checkMessages();
  }

  private async checkMessages(): Promise<CommandResult> {
    console.log('');
    console.log(fmt.info('  Scanning WhatsApp...'));

    try {
      const alreadyOpen = isOpen(PROFILE);
      const { page } = await getBrowser(PROFILE, alreadyOpen ? undefined : { visible: false });

      // Navigate to WhatsApp if not already there
      const currentUrl = page.url();
      if (!currentUrl.includes('web.whatsapp.com')) {
        console.log(fmt.dim('  [comms] Opening WhatsApp Web...'));
        await page.goto(WA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }

      // Wait for WhatsApp to load
      const readySelector = '#side, [data-testid="chat-list"], [aria-label="Search input textbox"], div[contenteditable="true"][data-tab="3"]';
      try {
        await page.waitForSelector(readySelector, { timeout: 15000 });
      } catch {
        if (!page.url().includes('web.whatsapp.com')) {
          return { success: false, message: 'WhatsApp not logged in. Run "whatsapp login" first.' };
        }
        await page.waitForTimeout(5000);
      }

      // Give page a moment to fully render chat list
      await page.waitForTimeout(2000);

      const unreadChats: UnreadChat[] = [];

      for (const chatName of MONITORED_CHATS) {
        console.log(fmt.dim(`  [comms] Checking: ${chatName}...`));

        try {
          // Find the search box and search for this chat
          const searchSelectors = [
            '[aria-label="Search input textbox"]',
            'div[contenteditable="true"][data-tab="3"]',
            '[data-testid="chat-list-search"]',
            '#side div[contenteditable="true"]',
          ];

          let searchClicked = false;
          for (const sel of searchSelectors) {
            try {
              const box = page.locator(sel).first();
              await box.click({ timeout: 3000 });
              searchClicked = true;
              await page.keyboard.press('Control+A');
              await page.keyboard.press('Backspace');
              await page.waitForTimeout(300);
              await page.keyboard.type(chatName, { delay: 20 });
              break;
            } catch { continue; }
          }

          if (!searchClicked) continue;

          // Wait for search results
          await page.waitForTimeout(2000);

          // Look for unread badge on the matching chat
          // WhatsApp shows unread count in a span with specific styling inside the chat row
          const result = await page.evaluate((name) => {
            // Find all chat rows in the search results
            const rows = document.querySelectorAll('[data-testid="cell-frame-container"], #side li, [role="listitem"], [role="row"]');

            for (const row of rows) {
              const titleEl = row.querySelector('span[title]');
              const title = titleEl?.getAttribute('title') || titleEl?.textContent || '';

              // Check if this row matches our chat name (case-insensitive partial match)
              if (!title.toLowerCase().includes(name.toLowerCase().slice(0, 10))) continue;

              // Look for unread badge — it's usually a small circle with a number
              // Try multiple selectors for the unread count
              const badgeSelectors = [
                '[data-testid="icon-unread-count"]',
                'span[aria-label*="unread"]',
                '.x1rg5ohu span',  // common WhatsApp badge class
                'span.aumms1qt',   // another badge class
              ];

              let unreadCount = '';
              for (const bSel of badgeSelectors) {
                const badge = row.querySelector(bSel);
                if (badge?.textContent?.trim()) {
                  unreadCount = badge.textContent.trim();
                  break;
                }
              }

              // Also check for any small circular element with a number (generic badge detection)
              if (!unreadCount) {
                const allSpans = row.querySelectorAll('span');
                for (const span of allSpans) {
                  const text = span.textContent?.trim() || '';
                  const style = window.getComputedStyle(span);
                  // Unread badges are typically small, centered, with green/colored background
                  if (/^\d+$/.test(text) && parseInt(text) > 0 && parseInt(text) < 1000) {
                    const parent = span.parentElement;
                    if (parent) {
                      const pStyle = window.getComputedStyle(parent);
                      // Check if it looks like a badge (circular, small, colored)
                      if (pStyle.borderRadius.includes('50%') || pStyle.borderRadius.includes('999') ||
                          parseFloat(pStyle.width) < 30 || style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
                        unreadCount = text;
                        break;
                      }
                    }
                  }
                }
              }

              // Get last message preview
              const previewEl = row.querySelector('[data-testid="last-msg-status"] + span, span[dir="ltr"]:not([title])');
              let lastMsg = '';
              if (previewEl) {
                lastMsg = previewEl.textContent?.trim()?.slice(0, 100) || '';
              }

              // Also try getting any secondary text that looks like a message preview
              if (!lastMsg) {
                const secondarySpans = row.querySelectorAll('span[dir="ltr"]');
                for (const s of secondarySpans) {
                  const t = s.textContent?.trim() || '';
                  if (t.length > 5 && !t.includes(name.slice(0, 5))) {
                    lastMsg = t.slice(0, 100);
                    break;
                  }
                }
              }

              return {
                found: true,
                title,
                unreadCount,
                lastMessage: lastMsg,
              };
            }

            return { found: false, title: '', unreadCount: '', lastMessage: '' };
          }, chatName);

          if (result.found && result.unreadCount) {
            unreadChats.push({
              name: result.title || chatName,
              unreadCount: result.unreadCount,
              lastMessage: result.lastMessage,
            });
            console.log(fmt.dim(`  [comms] ${chatName}: ${result.unreadCount} unread`));
          } else if (result.found) {
            console.log(fmt.dim(`  [comms] ${chatName}: no unread`));
          } else {
            console.log(fmt.dim(`  [comms] ${chatName}: not found in search`));
          }

          // Press Escape to clear search and go back to chat list
          await page.keyboard.press('Escape');
          await page.waitForTimeout(500);
          await page.keyboard.press('Escape');
          await page.waitForTimeout(500);
        } catch (err) {
          console.log(fmt.dim(`  [comms] Error checking ${chatName}: ${(err as Error).message}`));
          // Try to recover by pressing Escape
          try {
            await page.keyboard.press('Escape');
            await page.waitForTimeout(500);
          } catch (err) { log.debug('Failed to recover from search error', err); }
        }
      }

      if (unreadChats.length === 0) {
        const msg = 'All clear, sir. No unread messages in your monitored chats.';
        if (isVoiceEnabled()) speak(msg).catch(() => {});
        return { success: true, message: msg, voiceMessage: msg };
      }

      // Build briefing
      console.log('');
      console.log(fmt.dim('  [comms] Prioritizing...'));
      console.log('');

      const summary = unreadChats.map(c =>
        `${c.name}: ${c.unreadCount} unread${c.lastMessage ? ` — last: "${c.lastMessage}"` : ''}`
      ).join('\n');

      const brief = await this.prioritize(summary, unreadChats.length);

      if (isVoiceEnabled() && brief) {
        // Speak just the first key point
        const firstLine = brief.split('\n').find(l => l.trim().length > 10);
        if (firstLine) {
          speak(firstLine.replace(/^\d+[\.\)]\s*/, '').replace(/\*\*/g, '').slice(0, 150)).catch(() => {});
        }
      }

      return { success: true, message: brief || summary, streamed: !!brief };
    } catch (err) {
      return { success: false, message: `Comms check failed: ${(err as Error).message}` };
    }
  }

  private async prioritize(messages: string, count: number): Promise<string | null> {
    const systemPrompt = `You are JARVIS. Arhan asked "what needs my attention". You found ${count} chats with unread messages.

Give a crisp briefing. Be direct.

Rules:
- Lead with: "You have ${count} chat(s) that need attention, sir."
- For each: who/which group, how many unread, and the last message if available
- Flag anything time-sensitive as URGENT
- Keep it to 2-3 sentences per chat max
- Talk naturally, no markdown`;

    try {
      let output = '';
      process.stdout.write('  ');
      await llmStreamChat(
        [{ role: 'user', content: `Arhan's unread WhatsApp chats:\n\n${messages}` }],
        systemPrompt,
        (token) => {
          process.stdout.write(token);
          output += token;
        },
      );
      console.log('');
      return output;
    } catch (err) {
      log.warn('LLM prioritization failed', err);
      return null;
    }
  }

  getHelp(): string {
    return [
      '  Comms Stack — Message Intelligence',
      '    what needs my attention      Priority briefing',
      '    check messages               Scan WhatsApp',
      '    catch me up                  Unread summary',
      '    any messages                 Quick check',
    ].join('\n');
  }
}
