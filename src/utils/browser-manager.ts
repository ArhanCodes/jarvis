import { chromium, type BrowserContext, type Page } from 'playwright';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';

// ── Shared Browser Lifecycle Manager ──
// Manages persistent Playwright browser contexts for WhatsApp, general browsing, etc.
// Each profile gets its own user data directory so sessions persist across runs.

const __dirname = dirname(fileURLToPath(import.meta.url));

function getDataDir(profile: string): string {
  const paths = [
    join(__dirname, '..', '..', 'config', '.browser-data', profile),
    join(__dirname, '..', '..', '..', 'config', '.browser-data', profile),
  ];
  const configBase = existsSync(join(__dirname, '..', '..', 'config'))
    ? join(__dirname, '..', '..', 'config', '.browser-data', profile)
    : paths[0];
  if (!existsSync(configBase)) {
    mkdirSync(configBase, { recursive: true });
  }
  return configBase;
}

interface BrowserSession {
  context: BrowserContext;
  page: Page;
}

const sessions = new Map<string, BrowserSession>();

export async function getBrowser(
  profile: string,
  options?: { headless?: boolean; visible?: boolean },
): Promise<BrowserSession> {
  const existing = sessions.get(profile);
  if (existing) {
    // Check if browser is still alive
    try {
      await existing.page.title();
      return existing;
    } catch {
      sessions.delete(profile);
    }
  }

  const dataDir = getDataDir(profile);
  const headless = options?.visible ? false : (options?.headless ?? true);

  const context = await chromium.launchPersistentContext(dataDir, {
    headless,
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    args: [
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      '--no-first-run',
      '--disable-infobars',
      ...(headless ? [] : ['--start-maximized']),
    ],
  });

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  const session: BrowserSession = { context, page };
  sessions.set(profile, session);
  return session;
}

export async function getPage(profile: string): Promise<Page | null> {
  const session = sessions.get(profile);
  if (!session) return null;
  return session.page;
}

export async function closeBrowser(profile: string): Promise<void> {
  const session = sessions.get(profile);
  if (session) {
    try { await session.context.close(); } catch { /* ok */ }
    sessions.delete(profile);
  }
}

export async function closeAll(): Promise<void> {
  for (const [profile] of sessions) {
    await closeBrowser(profile);
  }
}

export function isOpen(profile: string): boolean {
  return sessions.has(profile);
}
