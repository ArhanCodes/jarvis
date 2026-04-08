import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { llmStreamChat } from '../utils/llm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configDir = join(__dirname, '..', '..', 'config');

// ── Config Loaders ──

interface SlackConfig {
  botToken: string;
  defaultChannel: string;
}

interface NotionConfig {
  apiKey: string;
  defaultDatabase: string;
}

interface StravaConfig {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}

function loadConfig<T>(filename: string, label: string): T {
  const p = join(configDir, filename);
  if (!existsSync(p)) {
    throw new Error(
      `${label} not configured. Create config/${filename} with the required fields. See module help for details.`,
    );
  }
  return JSON.parse(readFileSync(p, 'utf-8')) as T;
}

// ── Slack ──

async function slackApi(
  method: string,
  token: string,
  params?: Record<string, string>,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const url = new URL(`https://slack.com/api/${method}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = (await res.json()) as Record<string, unknown>;
  return { ok: data.ok as boolean, data };
}

async function handleSlack(args: Record<string, string>): Promise<CommandResult> {
  let cfg: SlackConfig;
  try {
    cfg = loadConfig<SlackConfig>('slack.json', 'Slack');
  } catch (e) {
    return { success: false, message: (e as Error).message };
  }

  const subAction = args.action || 'channels';
  const channel = args.channel || cfg.defaultChannel;

  switch (subAction) {
    case 'send': {
      const text = args.text || args.message;
      if (!text) return { success: false, message: 'No message text provided. Use: slack send #channel "message"' };
      const { ok, data } = await slackApi('chat.postMessage', cfg.botToken, undefined, {
        channel,
        text,
      });
      if (!ok) return { success: false, message: `Slack error: ${data.error || 'unknown'}` };
      return { success: true, message: `Message sent to ${channel}` };
    }

    case 'read': {
      const limit = args.limit || '10';
      const { ok, data } = await slackApi('conversations.history', cfg.botToken, {
        channel,
        limit,
      });
      if (!ok) return { success: false, message: `Slack error: ${data.error || 'unknown'}` };
      const messages = (data.messages as Array<{ text: string; user?: string; ts: string }>) || [];
      if (messages.length === 0) return { success: true, message: `No recent messages in ${channel}` };
      const formatted = messages
        .reverse()
        .map((m) => `[${new Date(Number(m.ts) * 1000).toLocaleTimeString()}] ${m.user || 'unknown'}: ${m.text}`)
        .join('\n');
      return { success: true, message: `Recent messages in ${channel}:\n${formatted}`, data: messages };
    }

    case 'channels': {
      const { ok, data } = await slackApi('conversations.list', cfg.botToken, {
        types: 'public_channel,private_channel',
        limit: '100',
      });
      if (!ok) return { success: false, message: `Slack error: ${data.error || 'unknown'}` };
      const channels = (data.channels as Array<{ name: string; id: string; num_members?: number }>) || [];
      const list = channels.map((c) => `#${c.name} (${c.num_members ?? '?'} members)`).join('\n');
      return { success: true, message: `Slack channels:\n${list}`, data: channels };
    }

    case 'search': {
      const query = args.query || args.text;
      if (!query) return { success: false, message: 'No search query provided.' };
      const { ok, data } = await slackApi('search.messages', cfg.botToken, { query });
      if (!ok) return { success: false, message: `Slack error: ${data.error || 'unknown'}` };
      const matches = ((data.messages as Record<string, unknown>)?.matches as Array<{
        text: string;
        username?: string;
        channel?: { name: string };
        ts: string;
      }>) || [];
      if (matches.length === 0) return { success: true, message: `No Slack messages found for "${query}"` };
      const formatted = matches
        .slice(0, 10)
        .map((m) => `[#${m.channel?.name || '?'}] ${m.username || '?'}: ${m.text}`)
        .join('\n');
      return { success: true, message: `Search results for "${query}":\n${formatted}`, data: matches };
    }

    default:
      return { success: false, message: `Unknown Slack action: ${subAction}. Use send, read, channels, or search.` };
  }
}

// ── Notion ──

async function notionApi(
  path: string,
  apiKey: string,
  method = 'GET',
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Notion-Version': '2022-06-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = (await res.json()) as Record<string, unknown>;
  return { ok: res.ok, data };
}

function extractNotionText(block: Record<string, unknown>): string {
  const type = block.type as string;
  const content = block[type] as Record<string, unknown> | undefined;
  if (!content) return '';
  const richText = content.rich_text as Array<{ plain_text: string }> | undefined;
  if (!richText) return '';
  return richText.map((t) => t.plain_text).join('');
}

async function handleNotion(args: Record<string, string>): Promise<CommandResult> {
  let cfg: NotionConfig;
  try {
    cfg = loadConfig<NotionConfig>('notion.json', 'Notion');
  } catch (e) {
    return { success: false, message: (e as Error).message };
  }

  const subAction = args.action || 'search';

  switch (subAction) {
    case 'search': {
      const query = args.query || args.text || '';
      const { ok, data } = await notionApi('/search', cfg.apiKey, 'POST', {
        query,
        page_size: 10,
      });
      if (!ok) return { success: false, message: `Notion error: ${(data.message as string) || 'unknown'}` };
      const results = (data.results as Array<{
        id: string;
        object: string;
        properties?: Record<string, { title?: Array<{ plain_text: string }> }>;
        url?: string;
      }>) || [];
      if (results.length === 0) return { success: true, message: `No Notion pages found for "${query}"` };
      const list = results
        .map((r) => {
          const titleProp = r.properties
            ? Object.values(r.properties).find((p) => p.title)
            : undefined;
          const title = titleProp?.title?.[0]?.plain_text || 'Untitled';
          return `- ${title} (${r.object}) [${r.id}]`;
        })
        .join('\n');
      return { success: true, message: `Notion search results:\n${list}`, data: results };
    }

    case 'read': {
      const pageId = args.page || args.id;
      if (!pageId) return { success: false, message: 'No page ID provided. Use: notion read <page-id>' };
      const { ok, data } = await notionApi(`/blocks/${pageId}/children?page_size=100`, cfg.apiKey);
      if (!ok) return { success: false, message: `Notion error: ${(data.message as string) || 'unknown'}` };
      const blocks = (data.results as Array<Record<string, unknown>>) || [];
      const text = blocks.map(extractNotionText).filter(Boolean).join('\n');
      if (!text) return { success: true, message: 'Page is empty or contains unsupported block types.' };
      return { success: true, message: `Notion page content:\n${text}`, data: blocks };
    }

    case 'create': {
      const title = args.title || 'Untitled';
      const content = args.content || args.text || '';
      const parentDb = args.database || cfg.defaultDatabase;
      if (!parentDb) {
        return { success: false, message: 'No database ID provided and no default database configured.' };
      }

      const body: Record<string, unknown> = {
        parent: { database_id: parentDb },
        properties: {
          Name: { title: [{ text: { content: title } }] },
        },
        children: content
          ? [
              {
                object: 'block',
                type: 'paragraph',
                paragraph: {
                  rich_text: [{ type: 'text', text: { content } }],
                },
              },
            ]
          : [],
      };

      const { ok, data } = await notionApi('/pages', cfg.apiKey, 'POST', body);
      if (!ok) return { success: false, message: `Notion error: ${(data.message as string) || 'unknown'}` };
      return {
        success: true,
        message: `Created Notion page "${title}" — ${(data.url as string) || data.id}`,
        data,
      };
    }

    case 'databases': {
      const { ok, data } = await notionApi('/search', cfg.apiKey, 'POST', {
        filter: { value: 'database', property: 'object' },
        page_size: 20,
      });
      if (!ok) return { success: false, message: `Notion error: ${(data.message as string) || 'unknown'}` };
      const dbs = (data.results as Array<{
        id: string;
        title?: Array<{ plain_text: string }>;
      }>) || [];
      if (dbs.length === 0) return { success: true, message: 'No Notion databases found.' };
      const list = dbs
        .map((d) => `- ${d.title?.[0]?.plain_text || 'Untitled'} [${d.id}]`)
        .join('\n');
      return { success: true, message: `Notion databases:\n${list}`, data: dbs };
    }

    default:
      return { success: false, message: `Unknown Notion action: ${subAction}. Use search, read, create, or databases.` };
  }
}

// ── Apple Health ──

function runShortcut(name: string): string | null {
  try {
    const result = execSync(`shortcuts run "${name}" 2>/dev/null`, {
      timeout: 15000,
      encoding: 'utf-8',
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

function runAppleScript(script: string): string | null {
  try {
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      timeout: 10000,
      encoding: 'utf-8',
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

const HEALTH_NOT_CONFIGURED =
  'Apple Health integration requires Shortcuts to be configured on your Mac. ' +
  'Create Shortcuts named "Get Steps", "Get Sleep", "Get Heart Rate", or "Get Health Summary" ' +
  'that return the relevant health data as text output.';

async function handleAppleHealth(args: Record<string, string>): Promise<CommandResult> {
  const subAction = args.action || 'summary';

  switch (subAction) {
    case 'steps': {
      const data = runShortcut('Get Steps');
      if (!data) return { success: false, message: HEALTH_NOT_CONFIGURED };
      return {
        success: true,
        message: `Today's steps: ${data}`,
        voiceMessage: `You have ${data} steps today.`,
        data: { steps: data },
      };
    }

    case 'sleep': {
      const data = runShortcut('Get Sleep');
      if (!data) return { success: false, message: HEALTH_NOT_CONFIGURED };
      return {
        success: true,
        message: `Last night's sleep: ${data}`,
        voiceMessage: `Your sleep data: ${data}`,
        data: { sleep: data },
      };
    }

    case 'heart-rate':
    case 'heartrate':
    case 'heart_rate': {
      const data = runShortcut('Get Heart Rate');
      if (!data) return { success: false, message: HEALTH_NOT_CONFIGURED };
      return {
        success: true,
        message: `Recent heart rate: ${data}`,
        voiceMessage: `Your heart rate is ${data}`,
        data: { heartRate: data },
      };
    }

    case 'summary': {
      const steps = runShortcut('Get Steps');
      const sleep = runShortcut('Get Sleep');
      const hr = runShortcut('Get Heart Rate');
      const healthSummary = runShortcut('Get Health Summary');

      if (!steps && !sleep && !hr && !healthSummary) {
        return { success: false, message: HEALTH_NOT_CONFIGURED };
      }

      const parts: string[] = [];
      if (steps) parts.push(`Steps: ${steps}`);
      if (sleep) parts.push(`Sleep: ${sleep}`);
      if (hr) parts.push(`Heart Rate: ${hr}`);
      if (healthSummary) parts.push(`Summary: ${healthSummary}`);

      const rawSummary = parts.join('\n');

      // Use LLM to produce a natural summary
      let summary = rawSummary;
      try {
        summary = await llmStreamChat(
          [{ role: 'user', content: `Summarize this health data in a brief, friendly way:\n${rawSummary}` }],
          'You are a helpful health assistant. Be concise and encouraging.',
          () => {},
        );
      } catch {
        // LLM unavailable; raw data is fine
      }

      return {
        success: true,
        message: summary,
        voiceMessage: summary,
        data: { steps, sleep, heartRate: hr, healthSummary },
      };
    }

    default:
      return {
        success: false,
        message: `Unknown Apple Health action: ${subAction}. Use steps, sleep, heart-rate, or summary.`,
      };
  }
}

// ── Strava ──

async function stravaFetch(
  path: string,
  retried = false,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  let cfg: StravaConfig;
  try {
    cfg = loadConfig<StravaConfig>('strava.json', 'Strava');
  } catch (e) {
    return { ok: false, status: 0, data: (e as Error).message };
  }

  const res = await fetch(`https://www.strava.com/api/v3${path}`, {
    headers: { Authorization: `Bearer ${cfg.accessToken}` },
  });

  if (res.status === 401 && !retried) {
    // Refresh token
    const refreshRes = await fetch('https://www.strava.com/api/v3/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: cfg.refreshToken,
      }),
    });

    if (!refreshRes.ok) {
      const errText = await refreshRes.text();
      return { ok: false, status: refreshRes.status, data: `Token refresh failed: ${errText}` };
    }

    const tokens = (await refreshRes.json()) as {
      access_token: string;
      refresh_token: string;
    };

    const updated: StravaConfig = {
      ...cfg,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
    };
    writeFileSync(join(configDir, 'strava.json'), JSON.stringify(updated, null, 2));

    return stravaFetch(path, true);
  }

  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDistance(meters: number): string {
  const km = meters / 1000;
  if (km >= 1) return `${km.toFixed(1)} km`;
  return `${meters.toFixed(0)} m`;
}

async function handleStrava(args: Record<string, string>): Promise<CommandResult> {
  const subAction = args.action || 'activities';

  switch (subAction) {
    case 'activities': {
      const limit = args.limit || '10';
      const { ok, data } = await stravaFetch(`/athlete/activities?per_page=${limit}`);
      if (!ok) return { success: false, message: `Strava error: ${data}` };
      const activities = data as Array<{
        name: string;
        type: string;
        distance: number;
        moving_time: number;
        start_date_local: string;
        id: number;
      }>;
      if (!activities || activities.length === 0) return { success: true, message: 'No recent Strava activities.' };
      const list = activities
        .map(
          (a) =>
            `- ${a.name} (${a.type}) — ${formatDistance(a.distance)}, ${formatDuration(a.moving_time)} on ${new Date(a.start_date_local).toLocaleDateString()}`,
        )
        .join('\n');
      return { success: true, message: `Recent Strava activities:\n${list}`, data: activities };
    }

    case 'stats': {
      // First get athlete ID
      const { ok: aOk, data: athlete } = await stravaFetch('/athlete');
      if (!aOk) return { success: false, message: `Strava error: ${athlete}` };
      const athleteId = (athlete as Record<string, unknown>).id;

      const { ok, data } = await stravaFetch(`/athletes/${athleteId}/stats`);
      if (!ok) return { success: false, message: `Strava error: ${data}` };
      const stats = data as Record<
        string,
        { count?: number; distance?: number; moving_time?: number; elevation_gain?: number }
      >;

      const parts: string[] = [];
      for (const [period, label] of [
        ['recent_run_totals', 'Recent Runs'],
        ['recent_ride_totals', 'Recent Rides'],
        ['recent_swim_totals', 'Recent Swims'],
        ['ytd_run_totals', 'YTD Runs'],
        ['ytd_ride_totals', 'YTD Rides'],
        ['all_run_totals', 'All-Time Runs'],
        ['all_ride_totals', 'All-Time Rides'],
      ] as const) {
        const s = stats[period];
        if (s && s.count && s.count > 0) {
          parts.push(
            `${label}: ${s.count} activities, ${formatDistance(s.distance || 0)}, ${formatDuration(s.moving_time || 0)}`,
          );
        }
      }

      if (parts.length === 0) return { success: true, message: 'No Strava stats available.' };
      return { success: true, message: `Strava stats:\n${parts.join('\n')}`, data: stats };
    }

    case 'activity': {
      const id = args.id || args.activity;
      if (!id) return { success: false, message: 'No activity ID provided. Use: strava activity <id>' };
      const { ok, data } = await stravaFetch(`/activities/${id}`);
      if (!ok) return { success: false, message: `Strava error: ${data}` };
      const a = data as Record<string, unknown>;
      const lines = [
        `Name: ${a.name}`,
        `Type: ${a.type}`,
        `Distance: ${formatDistance(a.distance as number)}`,
        `Duration: ${formatDuration(a.moving_time as number)}`,
        `Elevation Gain: ${((a.total_elevation_gain as number) || 0).toFixed(0)} m`,
        `Date: ${new Date(a.start_date_local as string).toLocaleString()}`,
        a.average_heartrate ? `Avg HR: ${a.average_heartrate} bpm` : null,
        a.max_heartrate ? `Max HR: ${a.max_heartrate} bpm` : null,
        a.average_speed ? `Avg Speed: ${(((a.average_speed as number) || 0) * 3.6).toFixed(1)} km/h` : null,
        a.description ? `Description: ${a.description}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      return { success: true, message: `Strava activity details:\n${lines}`, data: a };
    }

    default:
      return { success: false, message: `Unknown Strava action: ${subAction}. Use activities, stats, or activity.` };
  }
}

// ── Module Definition ──

const dataConnectorsModule: JarvisModule = {
  name: 'data-connectors',
  description: 'Unified access to external data sources: Slack, Notion, Apple Health, and Strava',

  patterns: [
    // Slack
    {
      intent: 'slack',
      patterns: [
        /\bslack\s+(send|post)\s+(?:#?(\S+)\s+)?(.+)/i,
        /\bsend\s+(?:a\s+)?slack\s+(?:message\s+)?(?:to\s+)?(?:#?(\S+)\s+)?(.+)/i,
      ],
      extract: (match, raw) => {
        if (/\bslack\s+(send|post)/i.test(raw)) {
          const m = raw.match(/\bslack\s+(?:send|post)\s+(?:#?(\S+)\s+)?(.+)/i);
          return { action: 'send', channel: m?.[1] || '', text: m?.[2] || '', connector: 'slack' };
        }
        const m = raw.match(/\bsend\s+(?:a\s+)?slack\s+(?:message\s+)?(?:to\s+)?(?:#?(\S+)\s+)?(.+)/i);
        return { action: 'send', channel: m?.[1] || '', text: m?.[2] || '', connector: 'slack' };
      },
    },
    {
      intent: 'slack',
      patterns: [
        /\bslack\s+(read|messages?)\s*(?:#?(\S+))?/i,
        /\bread\s+slack\s*(?:#?(\S+))?/i,
      ],
      extract: (match, raw) => {
        const m = raw.match(/(?:slack\s+(?:read|messages?)|read\s+slack)\s*(?:#?(\S+))?/i);
        return { action: 'read', channel: m?.[1] || '', connector: 'slack' };
      },
    },
    {
      intent: 'slack',
      patterns: [/\bslack\s+channels?\b/i],
      extract: () => ({ action: 'channels', connector: 'slack' }),
    },
    {
      intent: 'slack',
      patterns: [
        /\bslack\s+search\s+(.+)/i,
        /\bsearch\s+slack\s+(?:for\s+)?(.+)/i,
      ],
      extract: (match, raw) => {
        const m = raw.match(/(?:slack\s+search|search\s+slack\s+(?:for\s+)?)(.+)/i);
        return { action: 'search', query: m?.[1]?.trim() || '', connector: 'slack' };
      },
    },

    // Notion
    {
      intent: 'notion',
      patterns: [
        /\bnotion\s+search\s+(.+)/i,
        /\bsearch\s+notion\s+(?:for\s+)?(.+)/i,
      ],
      extract: (match, raw) => {
        const m = raw.match(/(?:notion\s+search|search\s+notion\s+(?:for\s+)?)(.+)/i);
        return { action: 'search', query: m?.[1]?.trim() || '', connector: 'notion' };
      },
    },
    {
      intent: 'notion',
      patterns: [/\bnotion\s+read\s+(\S+)/i],
      extract: (match) => ({ action: 'read', page: match[1], connector: 'notion' }),
    },
    {
      intent: 'notion',
      patterns: [
        /\bnotion\s+create\s+"([^"]+)"(?:\s+(.+))?/i,
        /\bnotion\s+create\s+(\S+)(?:\s+(.+))?/i,
        /\bcreate\s+(?:a\s+)?notion\s+page\s+"?([^"]+)"?/i,
      ],
      extract: (match, raw) => {
        const m =
          raw.match(/\bnotion\s+create\s+"([^"]+)"(?:\s+(.+))?/i) ||
          raw.match(/\bcreate\s+(?:a\s+)?notion\s+page\s+"?([^"]+)"?/i) ||
          raw.match(/\bnotion\s+create\s+(\S+)(?:\s+(.+))?/i);
        return { action: 'create', title: m?.[1] || 'Untitled', content: m?.[2] || '', connector: 'notion' };
      },
    },
    {
      intent: 'notion',
      patterns: [/\bnotion\s+databases?\b/i],
      extract: () => ({ action: 'databases', connector: 'notion' }),
    },

    // Apple Health
    {
      intent: 'apple-health',
      patterns: [
        /\b(?:apple\s+)?health\s+steps?\b/i,
        /\bhow\s+many\s+steps\b/i,
        /\bmy\s+steps?\b/i,
        /\bstep\s+count\b/i,
      ],
      extract: () => ({ action: 'steps', connector: 'apple-health' }),
    },
    {
      intent: 'apple-health',
      patterns: [
        /\b(?:apple\s+)?health\s+sleep\b/i,
        /\bhow\s+(?:did\s+)?i\s+sleep\b/i,
        /\bmy\s+sleep\b/i,
        /\bsleep\s+data\b/i,
      ],
      extract: () => ({ action: 'sleep', connector: 'apple-health' }),
    },
    {
      intent: 'apple-health',
      patterns: [
        /\b(?:apple\s+)?health\s+heart\s*rate\b/i,
        /\bmy\s+heart\s*rate\b/i,
        /\bheart\s+rate\b/i,
      ],
      extract: () => ({ action: 'heart-rate', connector: 'apple-health' }),
    },
    {
      intent: 'apple-health',
      patterns: [
        /\b(?:apple\s+)?health\s+summary\b/i,
        /\bmy\s+health\s+data\b/i,
        /\bhealth\s+summary\b/i,
        /\bhealth\s+overview\b/i,
      ],
      extract: () => ({ action: 'summary', connector: 'apple-health' }),
    },

    // Strava
    {
      intent: 'strava',
      patterns: [
        /\bstrava\s+activities\b/i,
        /\bstrava\s+recent\b/i,
        /\bmy\s+(?:recent\s+)?(?:workouts?|runs?|rides?|activities)\b/i,
      ],
      extract: () => ({ action: 'activities', connector: 'strava' }),
    },
    {
      intent: 'strava',
      patterns: [
        /\bstrava\s+stats\b/i,
        /\bmy\s+(?:fitness|strava|exercise)\s+stats\b/i,
      ],
      extract: () => ({ action: 'stats', connector: 'strava' }),
    },
    {
      intent: 'strava',
      patterns: [
        /\bstrava\s+(?:activity|workout)\s+(\S+)/i,
      ],
      extract: (match) => ({ action: 'activity', id: match[1], connector: 'strava' }),
    },
  ] as PatternDefinition[],

  async execute(command: ParsedCommand): Promise<CommandResult> {
    const { action, args } = command;
    const connector = args.connector || action;

    try {
      switch (connector) {
        case 'slack':
          return await handleSlack(args);
        case 'notion':
          return await handleNotion(args);
        case 'apple-health':
          return await handleAppleHealth(args);
        case 'strava':
          return await handleStrava(args);
        default:
          // Try to infer connector from action
          if (['send', 'read', 'channels', 'search'].includes(action) && args.text) {
            return await handleSlack({ ...args, action });
          }
          if (['steps', 'sleep', 'heart-rate', 'summary'].includes(action)) {
            return await handleAppleHealth({ ...args, action });
          }
          if (['activities', 'stats', 'activity'].includes(action)) {
            return await handleStrava({ ...args, action });
          }
          return {
            success: false,
            message: `Unknown data connector: ${connector}. Available: slack, notion, apple-health, strava.`,
          };
      }
    } catch (err) {
      return { success: false, message: `Data connector error: ${(err as Error).message}` };
    }
  },

  getHelp(): string {
    return [
      'Data Connectors — Unified external data access',
      '',
      'Slack:',
      '  slack send #channel "message" — Post a message',
      '  slack read #channel — Read recent messages',
      '  slack channels — List channels',
      '  slack search <query> — Search messages',
      '  Config: config/slack.json { "botToken": "xoxb-...", "defaultChannel": "#general" }',
      '',
      'Notion:',
      '  notion search <query> — Search pages',
      '  notion read <page-id> — Read page content',
      '  notion create "Title" content — Create a page',
      '  notion databases — List databases',
      '  Config: config/notion.json { "apiKey": "secret_...", "defaultDatabase": "" }',
      '',
      'Apple Health:',
      '  health steps — Today\'s step count',
      '  health sleep — Last night\'s sleep',
      '  health heart rate — Recent heart rate',
      '  health summary — Full health summary',
      '  Requires macOS Shortcuts: "Get Steps", "Get Sleep", "Get Heart Rate", "Get Health Summary"',
      '',
      'Strava:',
      '  strava activities — Recent activities',
      '  strava stats — Athlete stats',
      '  strava activity <id> — Activity details',
      '  Config: config/strava.json { "accessToken", "refreshToken", "clientId", "clientSecret" }',
    ].join('\n');
  },
};

export default dataConnectorsModule;
