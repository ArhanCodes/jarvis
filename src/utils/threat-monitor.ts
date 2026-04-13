/**
 * Threat Monitor — Always-on safety service
 *
 * Monitors news feeds for missile attacks, military activity,
 * and security threats relevant to Dubai/UAE.
 *
 * Alerts immediately via voice when a threat is detected.
 * Runs automatically when JARVIS boots. No activation needed.
 */

import { fmt } from './formatter.js';
import { speak } from './voice-output.js';
import { createLogger } from './logger.js';
import { readJsonConfig, writeJsonConfig } from './config.js';

const log = createLogger('threat-monitor');

// ── Config ──

interface ThreatConfig {
  checkIntervalMinutes: number;
  location: string;
  keywords: string[];
  sources: string[];
}

const DEFAULT_CONFIG: ThreatConfig = {
  checkIntervalMinutes: 5,
  location: 'UAE',
  keywords: [],
  sources: [
    // RSS feeds for breaking news
    'https://news.google.com/rss/search?q=UAE+missile+attack+OR+Dubai+attack+OR+houthi+UAE&hl=en&gl=AE&ceid=AE:en',
    'https://news.google.com/rss/search?q=Middle+East+military+strike+OR+Iran+attack+OR+Gulf+missile&hl=en&gl=AE&ceid=AE:en',
    // Al Jazeera Middle East
    'https://www.aljazeera.com/xml/rss/all.xml',
    // Reuters World
    'https://feeds.reuters.com/reuters/worldNews',
  ],
};

interface ThreatState {
  lastCheck: string | null;
  seenArticles: string[]; // article IDs/titles we've already alerted on
  alerts: { time: string; title: string; source: string; level: 'warning' | 'critical' }[];
}

// ── Persistence ──

function loadConfig(): ThreatConfig {
  const loaded = readJsonConfig<Partial<ThreatConfig>>('threat-monitor.json', {});
  if (Object.keys(loaded).length === 0) {
    writeJsonConfig('threat-monitor.json', DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
  return { ...DEFAULT_CONFIG, ...loaded };
}

function loadState(): ThreatState {
  return readJsonConfig<ThreatState>('threat-state.json', { lastCheck: null, seenArticles: [], alerts: [] });
}

function saveState(state: ThreatState): void {
  // Keep last 500 seen articles and 100 alerts
  if (state.seenArticles.length > 500) state.seenArticles = state.seenArticles.slice(-500);
  if (state.alerts.length > 100) state.alerts = state.alerts.slice(-100);
  writeJsonConfig('threat-state.json', state);
}

// ── RSS Feed Parser (simple XML extraction) ──

interface FeedItem {
  title: string;
  description: string;
  link: string;
  pubDate: string;
  source: string;
}

async function fetchRSS(url: string): Promise<FeedItem[]> {
  const items: FeedItem[] = [];
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'JARVIS-ThreatMonitor/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    const xml = await resp.text();

    // Simple regex XML parser for RSS items
    const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = itemPattern.exec(xml)) !== null) {
      const itemXml = match[1];
      const title = itemXml.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1]?.trim() || '';
      const desc = itemXml.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i)?.[1]?.trim() || '';
      const link = itemXml.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]?.trim() || '';
      const pubDate = itemXml.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim() || '';

      if (title) {
        items.push({
          title: title.replace(/<[^>]+>/g, ''),
          description: desc.replace(/<[^>]+>/g, '').slice(0, 300),
          link: link.replace(/<[^>]+>/g, ''),
          pubDate,
          source: new URL(url).hostname,
        });
      }
    }
  } catch (err) {
    log.debug(`RSS feed fetch failed: ${url}`, err);
  }
  return items;
}

// ── Threat Assessment ──

function assessThreat(item: FeedItem, _config: ThreatConfig): { isThreat: boolean; level: 'warning' | 'critical'; reason: string } {
  const text = `${item.title} ${item.description}`.toLowerCase();

  // Only recent articles (within last 1 hour)
  if (item.pubDate) {
    const pubTime = new Date(item.pubDate).getTime();
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    if (pubTime < oneHourAgo) {
      return { isThreat: false, level: 'warning', reason: 'old article' };
    }
  }

  // STRICT: article MUST mention UAE/Dubai/Abu Dhabi directly — no general Middle East news
  const uaeWords = ['uae', 'dubai', 'abu dhabi', 'united arab emirates', 'sharjah', 'ajman', 'al ain', 'fujairah', 'ras al khaimah'];
  const mentionsUAE = uaeWords.some(w => text.includes(w));

  if (!mentionsUAE) {
    // Does not mention UAE at all — not relevant, skip entirely
    return { isThreat: false, level: 'warning', reason: 'not UAE-specific' };
  }

  // CRITICAL: UAE is directly being attacked/hit/targeted RIGHT NOW
  // These phrases indicate an active, imminent, life-threatening situation
  const activeAttackPhrases = [
    'attack on uae', 'attack on dubai', 'attack on abu dhabi',
    'missile hit', 'missile hits', 'missile struck', 'missiles hit',
    'intercept', 'intercepted', 'air defences', 'air defenses',
    'explosion in dubai', 'explosion in abu dhabi', 'explosion in uae',
    'shelter in place', 'civil defense alert', 'siren', 'sirens',
    'evacuation', 'evacuate', 'incoming missile', 'incoming attack',
    'under attack', 'attacked uae', 'attacked dubai',
    'drone attack on', 'drone strike on',
    'casualties in dubai', 'casualties in uae', 'casualties in abu dhabi',
  ];

  const isActiveAttack = activeAttackPhrases.some(phrase => text.includes(phrase));

  if (isActiveAttack) {
    return { isThreat: true, level: 'critical', reason: 'ACTIVE THREAT — UAE under direct attack' };
  }

  // Everything else (general articles mentioning UAE + missiles/war/Iran) — NOT alerted
  // We only care about "your life is in danger right now"
  return { isThreat: false, level: 'warning', reason: 'not an active threat' };
}

// ── Main Check Cycle ──

async function runThreatCheck(): Promise<void> {
  const config = loadConfig();
  const state = loadState();

  // Fetch all RSS feeds in parallel
  const feedResults = await Promise.all(config.sources.map(url => fetchRSS(url)));
  const allItems = feedResults.flat();

  let newThreats = 0;

  for (const item of allItems) {
    // Skip if we've already seen this article
    const articleId = `${item.title.slice(0, 50)}|${item.link}`;
    if (state.seenArticles.includes(articleId)) continue;

    const assessment = assessThreat(item, config);

    if (assessment.isThreat) {
      // New threat detected!
      state.seenArticles.push(articleId);
      state.alerts.push({
        time: new Date().toISOString(),
        title: item.title,
        source: item.source,
        level: assessment.level,
      });

      newThreats++;

      if (assessment.level === 'critical') {
        // CRITICAL: immediate voice alert
        console.log('');
        console.log(fmt.error(`🚨 [THREAT ALERT — CRITICAL] ${item.title}`));
        console.log(fmt.warn(`   Source: ${item.source} | ${assessment.reason}`));
        console.log(fmt.dim(`   Link: ${item.link}`));
        console.log('');

        speak(`Security alert! ${item.title}. Stay alert, sir.`).catch(() => {});
      } else {
        // WARNING: log but lower urgency voice
        console.log('');
        console.log(fmt.warn(`⚠️  [THREAT MONITOR] ${item.title}`));
        console.log(fmt.dim(`   Source: ${item.source} | ${assessment.reason}`));
        console.log('');

        speak(`Heads up. ${item.title}`).catch(() => {});
      }
    } else {
      // Not a threat — still mark as seen so we don't re-check
      state.seenArticles.push(articleId);
    }
  }

  state.lastCheck = new Date().toISOString();
  saveState(state);
}

// ── Public API ──

let checkTimer: NodeJS.Timeout | null = null;

export function startThreatMonitor(): void {
  const config = loadConfig();

  // First check after 15 seconds
  setTimeout(() => {
    runThreatCheck().catch(() => {});
  }, 15_000);

  // Then every N minutes
  checkTimer = setInterval(() => {
    runThreatCheck().catch(() => {});
  }, config.checkIntervalMinutes * 60 * 1000);

  console.log(fmt.dim('  [jarvis] Threat monitor active — monitoring UAE security'));
}

export function stopThreatMonitor(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

/** Get current threat status */
export function getThreatStatus(): string {
  const state = loadState();
  const config = loadConfig();
  const lines: string[] = [];

  lines.push('Threat Monitor Status');
  lines.push(`  Location: ${config.location}`);
  lines.push(`  Check interval: every ${config.checkIntervalMinutes} minutes`);
  lines.push(`  Last check: ${state.lastCheck ? new Date(state.lastCheck).toLocaleString() : 'Never'}`);
  lines.push(`  Sources: ${config.sources.length} RSS feeds`);

  const recentAlerts = state.alerts.slice(-5);
  if (recentAlerts.length > 0) {
    lines.push('');
    lines.push('  Recent alerts:');
    for (const a of recentAlerts) {
      const icon = a.level === 'critical' ? '🚨' : '⚠️';
      lines.push(`    ${icon} [${new Date(a.time).toLocaleString()}] ${a.title}`);
    }
  } else {
    lines.push('  No recent threats ✓');
  }

  return lines.join('\n');
}

/** Force a manual check */
export async function runManualThreatCheck(): Promise<string> {
  await runThreatCheck();
  return getThreatStatus();
}
