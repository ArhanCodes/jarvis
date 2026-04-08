import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { getBrowser } from '../utils/browser-manager.js';
import { llmStreamChat } from '../utils/llm.js';
import { fmt } from '../utils/formatter.js';
import { speak, isVoiceEnabled } from '../utils/voice-output.js';

// ── The Dossier ──
// Real-time intelligence files on people and companies.
// Uses DuckDuckGo HTML + Bing, scrapes result pages, compiles via Claude.

const PROFILE = 'dossier';

export class DossierModule implements JarvisModule {
  name = 'dossier' as const;
  description = 'Build intelligence dossiers on people and companies';

  patterns: PatternDefinition[] = [
    {
      intent: 'dossier',
      patterns: [
        /^(?:dossier|brief\s+me)\s+(?:on\s+)?(.+)/i,
        /^(?:intel\s+on|profile)\s+(.+)/i,
        /^(?:background\s+check)\s+(?:on\s+)?(.+)/i,
        /^(?:look\s+up)\s+(.+)/i,
      ],
      extract: (match) => ({ target: (match[1] || match[2] || '').trim() }),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    const { target } = command.args;
    if (!target) {
      return { success: false, message: 'Who do you need a dossier on, sir?' };
    }
    return this.buildDossier(target);
  }

  private async buildDossier(target: string): Promise<CommandResult> {
    console.log('');
    console.log(fmt.info(`  Building dossier on: ${target}`));

    if (isVoiceEnabled()) {
      speak(`Building a dossier on ${target}. Give me a moment, sir.`).catch(() => {});
    }

    const intel: string[] = [];

    // Phase 1: DuckDuckGo HTML (no JS needed, no CAPTCHA)
    console.log(fmt.dim('  [dossier] Phase 1: Web search...'));
    const ddgData = await this.searchDDGHtml(`${target}`);
    if (ddgData.text) intel.push(`=== WEB SEARCH ===\n${ddgData.text}`);

    // Phase 2: LinkedIn via DuckDuckGo
    console.log(fmt.dim('  [dossier] Phase 2: LinkedIn...'));
    const liData = await this.searchDDGHtml(`${target} linkedin profile`);
    if (liData.text) intel.push(`=== LINKEDIN SEARCH ===\n${liData.text}`);

    // Phase 3: Visit top result pages for deeper content
    console.log(fmt.dim('  [dossier] Phase 3: Deep scan...'));
    const allUrls = [...ddgData.urls, ...liData.urls];
    const deepData = await this.scrapeTopPages(allUrls, target);
    if (deepData) intel.push(`=== PAGE CONTENT ===\n${deepData}`);

    if (intel.length === 0) {
      return {
        success: false,
        message: `Couldn't find anything on "${target}". Try adding context like their company or city.`,
        voiceMessage: `I couldn't find any intel on ${target}, sir. Try being more specific.`,
      };
    }

    // Phase 4: Compile with Claude
    console.log(fmt.dim('  [dossier] Phase 4: Compiling intelligence brief...'));
    console.log('');

    const brief = await this.compileBrief(target, intel.join('\n\n'));
    if (!brief) {
      return { success: true, message: `Raw intel on ${target}:\n\n${intel.join('\n\n')}` };
    }

    if (isVoiceEnabled()) {
      speak(`Dossier on ${target} is ready, sir.`).catch(() => {});
    }

    return { success: true, message: brief, streamed: true };
  }

  // ── DuckDuckGo HTML-only search (works without JS rendering) ──

  private async searchDDGHtml(query: string): Promise<{ text: string | null; urls: string[] }> {
    const urls: string[] = [];
    try {
      // DDG HTML version — no JavaScript required, no CAPTCHA
      const resp = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(15000),
      });
      const html = await resp.text();

      // Parse results from HTML
      const results: string[] = [];

      // Extract result blocks: <a class="result__a" href="...">title</a> + <a class="result__snippet">...</a>
      const resultPattern = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      let count = 0;
      while ((m = resultPattern.exec(html)) !== null && count < 10) {
        let url = m[1];
        const title = m[2].replace(/<[^>]+>/g, '').trim();
        const snippet = m[3].replace(/<[^>]+>/g, '').trim();

        // DDG wraps URLs in a redirect — extract the actual URL
        const actualUrl = url.match(/uddg=([^&]+)/);
        if (actualUrl) url = decodeURIComponent(actualUrl[1]);

        if (title && url.startsWith('http')) {
          results.push(`${title}\n${url}\n${snippet}`);
          urls.push(url);
          count++;
        }
      }

      // Fallback: try simpler pattern
      if (results.length === 0) {
        const linkPattern = /<a[^>]+class="result__url"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        while ((m = linkPattern.exec(html)) !== null && count < 10) {
          let url = m[1];
          const text = m[2].replace(/<[^>]+>/g, '').trim();
          const actualUrl = url.match(/uddg=([^&]+)/);
          if (actualUrl) url = decodeURIComponent(actualUrl[1]);
          if (text && url.startsWith('http')) {
            results.push(`${text}\n${url}`);
            urls.push(url);
            count++;
          }
        }
      }

      console.log(fmt.dim(`  [dossier] Found ${results.length} results`));
      return { text: results.length > 0 ? results.join('\n\n') : null, urls };
    } catch (err) {
      console.log(fmt.dim(`  [dossier] Search error: ${(err as Error).message}`));
      return { text: null, urls };
    }
  }

  // ── Scrape top result pages for deeper content ──

  private async scrapeTopPages(urls: string[], target: string): Promise<string | null> {
    // Filter to useful URLs, deduplicate, skip social media (login walls)
    const skipDomains = ['facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'youtube.com', 'tiktok.com', 'pinterest.com'];
    const seen = new Set<string>();
    const goodUrls = urls.filter(url => {
      if (seen.has(url)) return false;
      seen.add(url);
      return !skipDomains.some(d => url.includes(d));
    }).slice(0, 4); // Top 4 pages max

    if (goodUrls.length === 0) return null;

    const pageContents: string[] = [];

    try {
      const { page } = await getBrowser(PROFILE);

      for (const url of goodUrls) {
        try {
          console.log(fmt.dim(`  [dossier] Scanning: ${url.slice(0, 60)}...`));
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
          const text = await page.evaluate(() => {
            const remove = document.querySelectorAll('script, style, nav, footer, header, aside, [role="navigation"], [role="banner"], .cookie-banner, .ad, .advertisement');
            remove.forEach(el => el.remove());
            return document.body.innerText;
          });
          const cleaned = text
            .replace(/\n{3,}/g, '\n\n')
            .replace(/[ \t]+/g, ' ')
            .trim()
            .slice(0, 2500);

          // Only keep if it actually mentions the target
          const targetWords = target.toLowerCase().split(/\s+/);
          const hasRelevance = targetWords.some(w => cleaned.toLowerCase().includes(w));

          if (cleaned.length > 100 && hasRelevance) {
            pageContents.push(`Source: ${url}\n${cleaned}`);
          }
        } catch {
          continue;
        }
      }
    } catch {
      // Browser error
    }

    return pageContents.length > 0 ? pageContents.join('\n\n---\n\n') : null;
  }

  // ── Compile Brief with Claude ──

  private async compileBrief(target: string, rawIntel: string): Promise<string | null> {
    const systemPrompt = `You are JARVIS, Tony Stark's AI. You are compiling a dossier — an intelligence brief on a person or company for your principal, Arhan.

Your job: take raw web data and produce a clean, structured intelligence file. Be direct, factual, and concise. No fluff.

Format the dossier exactly like this:

═══ DOSSIER: [NAME] ═══

  Role: [Current title/position]
  Company: [Where they work/what they run]
  Location: [City, Country if found]
  LinkedIn: [URL if found]

  BACKGROUND
  • [Key fact 1]
  • [Key fact 2]
  • [Key fact 3]

  CAREER
  • [Notable position 1]
  • [Notable position 2]

  NOTABLE
  • [Achievements, press mentions, interesting facts]

  CONNECTIONS
  • [Any shared connections, mutual interests, or relevant context for Arhan]

  TALKING POINTS
  • [2-3 conversation starters based on their profile]

═══════════════════════

Rules:
- Only include facts you can verify from the data provided
- If something is unclear, say "unconfirmed" — never fabricate
- If a section has no data, omit it entirely rather than guessing
- If it's a company, adjust sections: CEO, Founded, Funding, Product, Competitors
- Keep it tight — this is a quick briefing, not an essay
- Start with "Sir, here's what I've found on..."`;

    try {
      let output = '';
      process.stdout.write('  ');
      await llmStreamChat(
        [{ role: 'user', content: `Build a dossier on "${target}" using this raw intelligence:\n\n${rawIntel}` }],
        systemPrompt,
        (token) => {
          process.stdout.write(token);
          output += token;
        },
      );
      console.log('');
      return output;
    } catch {
      return null;
    }
  }

  getHelp(): string {
    return [
      '  The Dossier',
      '    dossier <name>              Build intelligence file on a person',
      '    dossier <company>           Intel on a company',
      '    who is <name>               Quick profile lookup',
      '    brief me on <name>          Same as dossier',
      '    background check <name>     Deep dive',
    ].join('\n');
  }
}
