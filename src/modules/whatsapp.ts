import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { getBrowser, closeBrowser, isOpen } from '../utils/browser-manager.js';
import { fmt } from '../utils/formatter.js';
import { execSync } from 'child_process';
import { generate, isOllamaRunning } from '../utils/ollama.js';
import { getActiveModel } from './ai-chat.js';

// ── WhatsApp Module ──
// Send and read WhatsApp messages via WhatsApp Web + Playwright.
// Persistent browser context keeps the session alive across runs.

const PROFILE = 'whatsapp';
const WA_URL = 'https://web.whatsapp.com';

export class WhatsAppModule implements JarvisModule {
  name = 'whatsapp' as const;
  description = 'Send and read WhatsApp messages';

  patterns: PatternDefinition[] = [
    {
      intent: 'login',
      patterns: [
        /^whatsapp\s+(?:login|connect|setup|link|pair)$/i,
        /^(?:connect|link|setup)\s+whatsapp$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'send',
      patterns: [
        /^(?:send\s+)?(?:a\s+)?whatsapp\s+(?:to\s+)?(.+?)[\s:]+(?:saying\s+|message\s+)?["']?(.+?)["']?$/i,
        /^(?:message|text|whatsapp)\s+(.+?)\s+(?:on\s+whatsapp\s+)?(?:saying|:)\s*["']?(.+?)["']?$/i,
        /^(?:send\s+(?:a\s+)?(?:message|text)\s+(?:to\s+)?)(.+?)\s+(?:on\s+whatsapp\s+)?(?:saying|:)\s*["']?(.+?)["']?$/i,
        /^(?:tell|ask)\s+(.+?)\s+(?:on\s+whatsapp\s+)?(?:that|to|:)\s*["']?(.+?)["']?$/i,
        // "send a message to <name> on whatsapp <msg>" — strip platform specifier
        /^send\s+(?:a\s+)?(?:message|text)\s+to\s+(.+?)\s+on\s+whatsapp\s+(.+)$/i,
        /^(?:message|text)\s+(.+?)\s+on\s+whatsapp\s+(.+)$/i,
        // Simple: "message <name> <msg>" or "text <name> <msg>"
        /^(?:message|text|whatsapp)\s+(\S+)\s+["']?(.+?)["']?$/i,
        /^send\s+(?:a\s+)?(?:message|text)\s+to\s+(\S+)\s+["']?(.+?)["']?$/i,
      ],
      extract: (match) => ({
        contact: match[1].trim().replace(/\s+on\s+whatsapp$/i, '').trim(),
        message: match[2].trim().replace(/^on\s+whatsapp\s+/i, '').trim(),
      }),
    },
    {
      intent: 'read',
      patterns: [
        /^(?:read|check|show)\s+(?:my\s+)?whatsapp(?:\s+messages?)?$/i,
        /^whatsapp\s+(?:messages?|unread|inbox)$/i,
        /^(?:any|do\s+i\s+have(?:\s+any)?)\s+(?:new\s+)?(?:whatsapp\s+)?messages?$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'status',
      patterns: [
        /^whatsapp\s+status$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'close',
      patterns: [
        /^(?:close|disconnect)\s+whatsapp$/i,
        /^whatsapp\s+(?:close|disconnect)$/i,
      ],
      extract: () => ({}),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'login':   return this.login();
      case 'send':    return this.send(command.args.contact, command.args.message, command.raw);
      case 'read':    return this.read();
      case 'status':  return this.status();
      case 'close':   return this.close();
      default:
        return { success: false, message: `Unknown WhatsApp action: ${command.action}` };
    }
  }

  private async login(): Promise<CommandResult> {
    process.stdout.write(fmt.dim('  Opening WhatsApp Web...\n'));

    try {
      const { page } = await getBrowser(PROFILE, { visible: true });
      await page.goto(WA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Bring browser window to front so user can see QR code
      await page.bringToFront();
      try { execSync('osascript -e \'tell application "Chromium" to activate\' 2>/dev/null || osascript -e \'tell application "Google Chrome" to activate\' 2>/dev/null', { stdio: 'ignore' }); } catch { /* ok */ }

      // Quick check: already logged in?
      try {
        const loggedIn = await page.waitForSelector('#side, [data-testid="chat-list"], [aria-label="Search input textbox"], div[contenteditable="true"][data-tab="3"]', { timeout: 8000 });
        if (loggedIn) {
          return { success: true, message: 'WhatsApp Web is already logged in! Send messages with: message <name> <message>' };
        }
      } catch {
        // Not logged in — QR code should be showing
      }

      // Return immediately — don't block the event loop waiting for QR scan.
      // The persistent browser context will save the session once the user scans.
      return {
        success: true,
        message: 'WhatsApp Web is open — scan the QR code in the browser window.\n  Once scanned, the session is saved. Use "send whatsapp to <name>: <message>" to send.',
        voiceMessage: 'WhatsApp is open. Scan the QR code with your phone.',
      };
    } catch (err) {
      return { success: false, message: `WhatsApp login failed: ${(err as Error).message}` };
    }
  }

  /**
   * Detect if the message is a task instruction (e.g. "explaining what inflation is")
   * rather than a literal message to send. Quoted messages are always literal.
   */
  private isTaskInstruction(msg: string, raw: string): boolean {
    // If the user put the message in quotes, always send literally
    if (/["']/.test(raw) && (raw.includes(`"${msg}"`) || raw.includes(`'${msg}'`) || raw.includes(`"${msg}`) || raw.includes(`'${msg}`))) {
      return false;
    }

    // Gerund forms that imply "compose this for me"
    return /^(?:explaining|telling|describing|asking|summarizing|informing|writing|reminding|updating|letting|giving|sending|sharing|forwarding|congratulating|thanking|apologizing|inviting|notifying|warning|complimenting)/i.test(msg);
  }

  private async send(contact: string, message: string, raw: string): Promise<CommandResult> {
    if (!contact || !message) {
      return { success: false, message: 'Usage: send whatsapp to <contact>: <message>' };
    }

    // Smart message: if it looks like a task instruction, use AI to compose
    let finalMessage = message;
    if (this.isTaskInstruction(message, raw)) {
      try {
        if (await isOllamaRunning()) {
          process.stdout.write(fmt.dim(`  Composing message...\n`));
          const prompt = `Write a short, casual WhatsApp message to ${contact} that does the following: ${message}.\nOutput ONLY the message text. No quotes, no labels, no explanation.`;
          const generated = await generate(getActiveModel(), prompt);
          if (generated?.trim()) {
            finalMessage = generated.trim();
            console.log(fmt.dim(`  [composed] "${finalMessage}"`));
          }
        }
      } catch {
        // AI not available — send the literal instruction as fallback
      }
    }

    process.stdout.write(fmt.dim(`  Opening WhatsApp...\n`));

    try {
      // Reuse existing session if open (e.g. from login), otherwise launch visible
      const alreadyOpen = isOpen(PROFILE);
      const { page } = await getBrowser(PROFILE, alreadyOpen ? undefined : { visible: true });

      // Navigate to WhatsApp if not already there
      const currentUrl = page.url();
      if (!currentUrl.includes('web.whatsapp.com')) {
        await page.goto(WA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }

      // Wait for WhatsApp to load — try many selectors since WhatsApp Web changes often
      process.stdout.write(fmt.dim(`  Waiting for WhatsApp to be ready...\n`));
      const readySelector = '#side, [data-testid="chat-list"], [aria-label="Search input textbox"], div[contenteditable="true"][data-tab="3"], [data-testid="chatlist-header"]';
      try {
        await page.waitForSelector(readySelector, { timeout: 20000 });
      } catch {
        // Last resort: check if we're on WhatsApp and page has any content
        const url = page.url();
        if (!url.includes('web.whatsapp.com')) {
          return { success: false, message: 'WhatsApp not logged in. Run "whatsapp login" first to scan the QR code.' };
        }
        // Give it more time — maybe slow connection
        await page.waitForTimeout(5000);
      }

      // Search for the contact
      process.stdout.write(fmt.dim(`  Finding "${contact}"...\n`));

      // Find the search box — try multiple strategies
      const searchSelectors = [
        '[aria-label="Search input textbox"]',
        'div[contenteditable="true"][data-tab="3"]',
        '[data-testid="chat-list-search"]',
        '#side div[contenteditable="true"]',
        '[title="Search input textbox"]',
        'div[role="textbox"][data-tab="3"]',
      ];

      let searchClicked = false;
      for (const sel of searchSelectors) {
        try {
          const box = page.locator(sel).first();
          await box.click({ timeout: 3000 });
          searchClicked = true;
          // Clear any existing text and type contact name
          await page.keyboard.press('Control+A');
          await page.keyboard.type(contact, { delay: 30 });
          break;
        } catch { continue; }
      }

      if (!searchClicked) {
        // Fallback: try Ctrl+F or click the search area at the top of the sidebar
        try {
          // Click at the top of the sidebar where search usually is
          const side = page.locator('#side').first();
          const box = await side.boundingBox();
          if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + 40);
            await page.waitForTimeout(500);
            await page.keyboard.type(contact, { delay: 30 });
            searchClicked = true;
          }
        } catch { /* continue */ }
      }

      if (!searchClicked) {
        return { success: false, message: `Could not find the WhatsApp search box. WhatsApp Web may have updated its layout.` };
      }

      await page.waitForTimeout(2000); // Wait for search results

      // Click the first matching contact
      try {
        // Look for contact in search results — try multiple selectors
        const result = page.locator(`span[title*="${contact}" i]`).first();
        await result.waitFor({ timeout: 5000 });
        await result.click();
      } catch {
        // Try a broader match — click first result in chat list
        try {
          const firstResult = page.locator('[data-testid="cell-frame-container"]').first();
          await firstResult.click({ timeout: 5000 });
        } catch {
          try {
            // Last resort: try any list item in search results
            const listItem = page.locator('#side li, #side [role="listitem"], #side [data-testid="chat-list"] > div > div').first();
            await listItem.click({ timeout: 3000 });
          } catch {
            return { success: false, message: `Could not find contact "${contact}". Make sure the name matches a WhatsApp contact.` };
          }
        }
      }

      await page.waitForTimeout(1000);

      // Type and send the message
      process.stdout.write(fmt.dim(`  Sending message...\n`));

      // Find the message input — try multiple selectors
      const msgSelectors = [
        '[aria-label="Type a message"]',
        '[data-testid="conversation-compose-box-input"]',
        'div[contenteditable="true"][data-tab="10"]',
        'footer div[contenteditable="true"]',
        '#main div[contenteditable="true"]',
        '#main footer div[role="textbox"]',
      ];

      let msgTyped = false;
      for (const sel of msgSelectors) {
        try {
          const box = page.locator(sel).first();
          await box.click({ timeout: 3000 });
          await page.keyboard.type(finalMessage, { delay: 10 });
          msgTyped = true;
          break;
        } catch { continue; }
      }

      if (!msgTyped) {
        return { success: false, message: `Found "${contact}" but could not find the message input box.` };
      }

      await page.waitForTimeout(300);

      // Press Enter to send
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1000);

      return {
        success: true,
        message: `WhatsApp message sent to ${contact}: "${finalMessage}"`,
        voiceMessage: `Message sent to ${contact}.`,
      };
    } catch (err) {
      return { success: false, message: `Failed to send WhatsApp: ${(err as Error).message}` };
    }
  }

  private async read(): Promise<CommandResult> {
    process.stdout.write(fmt.dim('  Opening WhatsApp...\n'));

    try {
      // Reuse existing session if open (e.g. from login), otherwise launch headless
      const alreadyOpen = isOpen(PROFILE);
      const { page } = await getBrowser(PROFILE, alreadyOpen ? undefined : { headless: true });

      // Navigate to WhatsApp if not already there
      const currentUrl = page.url();
      if (!currentUrl.includes('web.whatsapp.com')) {
        await page.goto(WA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }

      try {
        await page.waitForSelector('#side, [data-testid="chat-list"], [aria-label="Search input textbox"], div[contenteditable="true"][data-tab="3"]', { timeout: 20000 });
      } catch {
        const url = page.url();
        if (!url.includes('web.whatsapp.com')) {
          return { success: false, message: 'WhatsApp not logged in. Run "whatsapp login" first.' };
        }
        await page.waitForTimeout(5000);
      }

      await page.waitForTimeout(2000); // Let chats load

      // Extract recent chats with unread indicators
      const chats = await page.evaluate(() => {
        const items: Array<{ name: string; lastMsg: string; unread: string }> = [];
        const cells = document.querySelectorAll('[data-testid="cell-frame-container"]');

        for (let i = 0; i < Math.min(cells.length, 10); i++) {
          const cell = cells[i];
          const nameEl = cell.querySelector('[data-testid="cell-frame-title"] span[title]');
          const msgEl = cell.querySelector('[data-testid="last-msg-status"] span[title], span.matched-text, [data-testid="cell-frame-secondary"] span[title]');
          const badgeEl = cell.querySelector('[data-testid="icon-unread-count"], [aria-label*="unread"]');

          const name = nameEl?.getAttribute('title') || nameEl?.textContent || 'Unknown';
          const lastMsg = msgEl?.getAttribute('title') || msgEl?.textContent || '';
          const unread = badgeEl?.textContent || '';

          items.push({ name, lastMsg: lastMsg.slice(0, 100), unread });
        }
        return items;
      });

      if (chats.length === 0) {
        return { success: true, message: 'No recent chats found.' };
      }

      const lines = chats.map(c => {
        const badge = c.unread ? ` [${c.unread} new]` : '';
        const msg = c.lastMsg ? `: ${c.lastMsg}` : '';
        return `  ${c.name}${badge}${msg}`;
      });

      const unreadCount = chats.filter(c => c.unread).length;
      const header = unreadCount > 0
        ? `${unreadCount} chat(s) with unread messages:`
        : 'Recent chats:';

      const voiceMsg = unreadCount > 0
        ? `You have ${unreadCount} unread WhatsApp chats from ${chats.filter(c => c.unread).map(c => c.name).join(', ')}.`
        : 'No unread WhatsApp messages.';

      return { success: true, message: `${header}\n\n${lines.join('\n')}`, voiceMessage: voiceMsg };
    } catch (err) {
      return { success: false, message: `Failed to read WhatsApp: ${(err as Error).message}` };
    }
  }

  private async status(): Promise<CommandResult> {
    if (!isOpen(PROFILE)) {
      return { success: true, message: 'WhatsApp: Not connected. Run "whatsapp login" to set up.' };
    }
    return { success: true, message: 'WhatsApp: Browser session active.' };
  }

  private async close(): Promise<CommandResult> {
    if (!isOpen(PROFILE)) {
      return { success: true, message: 'WhatsApp browser is not open.' };
    }
    await closeBrowser(PROFILE);
    return { success: true, message: 'WhatsApp browser closed. Session saved — will reconnect automatically next time.' };
  }

  getHelp(): string {
    return [
      '  WhatsApp',
      '    whatsapp login              Connect WhatsApp (scan QR code)',
      '    send whatsapp to <name>: <msg>  Send a message',
      '    whatsapp <name>: <msg>      Send (shorthand)',
      '    read whatsapp               Check recent messages',
      '    whatsapp status             Connection status',
      '    close whatsapp              Close browser session',
    ].join('\n');
  }
}
