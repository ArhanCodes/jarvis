import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { execSync } from 'child_process';
import { llmStreamChat } from '../utils/llm.js';

export class FlightFinderModule implements JarvisModule {
  name = 'flight-finder' as const;
  description = 'Search for flights using Google Flights';

  patterns: PatternDefinition[] = [
    {
      intent: 'search',
      patterns: [
        /^(?:find\s+)?flights?\s+from\s+(.+?)\s+to\s+(.+?)(?:\s+on\s+(.+))?$/i,
        /^(?:search|look\s+(?:up|for))\s+flights?\s+(?:from\s+)?(.+?)\s+to\s+(.+?)(?:\s+on\s+(.+))?$/i,
        /^(?:cheap\s+)?flights?\s+to\s+(.+?)(?:\s+(?:from\s+(.+?))?)?(?:\s+on\s+(.+))?$/i,
        /^(?:book|get)\s+(?:a\s+)?flight\s+(?:from\s+)?(.+?)\s+to\s+(.+?)(?:\s+on\s+(.+))?$/i,
      ],
      extract: (match, raw) => {
        // Handle "flights to DEST" pattern (no origin) — pattern index 2
        // vs "flights from ORIGIN to DEST" — patterns 0, 1, 3
        const lowerRaw = raw.toLowerCase();
        const hasFrom = /\bfrom\b/.test(lowerRaw);

        if (!hasFrom && match[2] === undefined) {
          // Pattern: "flights to DEST [on DATE]"
          return {
            origin: '',
            destination: match[1]?.trim() || '',
            date: match[3]?.trim() || '',
          };
        }

        // For "flights to DEST from ORIGIN" (pattern index 2 with group 2)
        if (!hasFrom || (match[2] && !/\bfrom\b/.test(lowerRaw.split('to')[0]))) {
          // Check if this matched the "flights to X from Y" pattern
          const toFromMatch = raw.match(/flights?\s+to\s+(.+?)\s+from\s+(.+?)(?:\s+on\s+(.+))?$/i);
          if (toFromMatch) {
            return {
              origin: toFromMatch[2]?.trim() || '',
              destination: toFromMatch[1]?.trim() || '',
              date: toFromMatch[3]?.trim() || '',
            };
          }
        }

        return {
          origin: match[1]?.trim() || '',
          destination: match[2]?.trim() || '',
          date: match[3]?.trim() || '',
        };
      },
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    switch (command.action) {
      case 'search': return this.searchFlights(command.args.origin, command.args.destination, command.args.date);
      default: return { success: false, message: `Unknown action: ${command.action}` };
    }
  }

  private buildGoogleFlightsUrl(origin: string, destination: string, date: string): string {
    const parts = ['flights'];
    if (origin) parts.push(`from ${origin}`);
    parts.push(`to ${destination}`);
    if (date) parts.push(`on ${date}`);

    const query = encodeURIComponent(parts.join(' '));
    return `https://www.google.com/travel/flights?q=${query}`;
  }

  private async searchFlights(origin: string, destination: string, date: string): Promise<CommandResult> {
    if (!destination) {
      return { success: false, message: 'Please specify a destination. Example: "flights from SFO to NYC on June 15"' };
    }

    try {
      const url = this.buildGoogleFlightsUrl(origin, destination, date);

      // Open in browser
      execSync(`open "${url}"`);

      // Try to fetch the page for any price info
      let priceInfo = '';
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });

        if (response.ok) {
          const html = await response.text();
          // Try to find price patterns like $123, $1,234
          const prices = html.match(/\$[\d,]+/g);
          if (prices && prices.length > 0) {
            const uniquePrices = Array.from(new Set(prices)).slice(0, 5);
            priceInfo = `\n\nPrices spotted: ${uniquePrices.join(', ')}`;
          }
        }
      } catch {
        // Price fetching is best-effort
      }

      // Use LLM to format a helpful response
      let llmResponse = '';
      const originLabel = origin || 'your location';
      const dateLabel = date || 'flexible dates';

      try {
        const systemPrompt = 'You are a helpful travel assistant. Give a brief, friendly response about the flight search. Include practical tips like best time to book, nearby airports to check, or travel advice. Keep it to 3-4 sentences max.';

        const userMessage = `I just searched for flights from ${originLabel} to ${destination} on ${dateLabel}. The Google Flights page has been opened in my browser.${priceInfo ? ` Some prices I found: ${priceInfo}` : ''} Give me a brief helpful response.`;

        llmResponse = await llmStreamChat(
          [{ role: 'user', content: userMessage }],
          systemPrompt,
          () => {},
        );
      } catch {
        // Fallback without LLM
        llmResponse = `I've opened Google Flights for you. Check the browser for the latest prices and options.`;
      }

      const searchDesc = [
        origin ? `From: ${origin}` : 'From: (not specified — set your origin on the page)',
        `To: ${destination}`,
        date ? `Date: ${date}` : 'Date: flexible',
      ].join('\n    ');

      const message = [
        `Flight Search:`,
        `    ${searchDesc}`,
        ``,
        `  Google Flights opened in browser.`,
        `  ${url}`,
        priceInfo ? `\n  ${priceInfo.trim()}` : '',
        ``,
        llmResponse,
      ].filter(Boolean).join('\n');

      return {
        success: true,
        message,
        voiceMessage: `I've opened Google Flights to search for flights ${origin ? `from ${origin} ` : ''}to ${destination}${date ? ` on ${date}` : ''}. Check your browser for results.`,
        data: { origin, destination, date, url },
      };
    } catch (err) {
      return { success: false, message: `Failed to search flights: ${(err as Error).message}` };
    }
  }

  getHelp(): string {
    return [
      '  Flight Finder — search for flights via Google Flights',
      '    flights from <origin> to <dest>           Search flights',
      '    flights from <origin> to <dest> on <date> Search with date',
      '    flights to <dest>                          Search without origin',
      '    cheap flights to <dest>                    Find budget options',
    ].join('\n');
  }
}
