import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { llmStreamChat } from '../utils/llm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configDir = join(__dirname, '..', '..', 'config');
const tokensPath = join(configDir, 'google-tokens.json');
const credentialsPath = join(configDir, 'google-credentials.json');

interface GoogleTokens {
  access_token: string;
  refresh_token: string;
  expiry_date?: number;
}

interface GoogleCredentials {
  installed?: { client_id: string; client_secret: string; redirect_uris: string[] };
  web?: { client_id: string; client_secret: string; redirect_uris: string[] };
}

function getAuthClient() {
  if (!existsSync(credentialsPath)) {
    throw new Error('Google credentials not found. Place google-credentials.json in config/.');
  }
  if (!existsSync(tokensPath)) {
    throw new Error('Gmail not configured. Run the OAuth setup.');
  }

  const creds: GoogleCredentials = JSON.parse(readFileSync(credentialsPath, 'utf-8'));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web || {};
  if (!client_id || !client_secret) {
    throw new Error('Invalid google-credentials.json format.');
  }

  const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0]);
  const tokens: GoogleTokens = JSON.parse(readFileSync(tokensPath, 'utf-8'));
  oauth2.setCredentials(tokens);

  oauth2.on('tokens', (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    writeFileSync(tokensPath, JSON.stringify(merged, null, 2));
  });

  return oauth2;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function getHeader(headers: Array<{ name?: string | null; value?: string | null }>, name: string): string {
  return headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

export class EmailModule implements JarvisModule {
  name = 'email' as const;
  description = 'Read, send, and search Gmail';

  patterns: PatternDefinition[] = [
    {
      intent: 'inbox',
      patterns: [
        /^(?:check |show |get )?(?:my )?(?:inbox|unread emails?|new emails?)$/i,
        /^(?:any )?(?:new )?(?:emails?|mail)$/i,
      ],
      extract: () => ({}),
    },
    {
      intent: 'read',
      patterns: [
        /^(?:read |open |show )(?:email |message )?(?:#?\s*)?(\d+)$/i,
        /^(?:read |open |show )(?:the )?(?:email|message) (?:from |about )(.+)$/i,
      ],
      extract: (match) => ({ query: match[1] || '' }),
    },
    {
      intent: 'send',
      patterns: [
        /^(?:send |compose |write )(?:an? )?(?:email|mail|message) to (.+)$/i,
        /^(?:email|mail) (.+)$/i,
      ],
      extract: (match, raw) => ({ to: match[1] || '', raw }),
    },
    {
      intent: 'search',
      patterns: [
        /^(?:search |find )(?:emails?|mail|messages?) (?:for |about )?(.+)$/i,
        /^(?:search |find )(.+) (?:in )?(?:email|mail|gmail)$/i,
      ],
      extract: (match) => ({ query: match[1] || '' }),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    try {
      switch (command.action) {
        case 'inbox': return await this.inbox();
        case 'read': return await this.readEmail(command.args);
        case 'send': return await this.sendEmail(command.args);
        case 'search': return await this.searchEmails(command.args);
        default: return { success: false, message: `Unknown email action: ${command.action}` };
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('not configured') || msg.includes('not found')) {
        return { success: false, message: msg };
      }
      return { success: false, message: `Email error: ${msg}` };
    }
  }

  private async inbox(): Promise<CommandResult> {
    const auth = getAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });

    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults: 10,
    });

    const messages = res.data.messages || [];
    if (messages.length === 0) {
      return { success: true, message: 'No unread emails.' };
    }

    const details = await Promise.all(
      messages.map(async (m, i) => {
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id: m.id!,
          format: 'metadata',
          metadataHeaders: ['Subject', 'From'],
        });
        const headers = msg.data.payload?.headers || [];
        const subject = getHeader(headers, 'Subject') || '(no subject)';
        const from = getHeader(headers, 'From');
        const snippet = msg.data.snippet || '';
        return `${i + 1}. ${from}\n   ${subject}\n   ${snippet}`;
      })
    );

    return { success: true, message: `Unread emails (${messages.length}):\n\n${details.join('\n\n')}` };
  }

  private async readEmail(args: Record<string, string>): Promise<CommandResult> {
    const auth = getAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });
    const query = args.query || '';

    let messageId: string | undefined;

    if (/^\d+$/.test(query)) {
      const idx = parseInt(query, 10) - 1;
      const list = await gmail.users.messages.list({
        userId: 'me',
        q: 'is:unread',
        maxResults: 10,
      });
      messageId = list.data.messages?.[idx]?.id ?? undefined;
      if (!messageId) return { success: false, message: `No email at index ${idx + 1}.` };
    } else {
      const list = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 1,
      });
      messageId = list.data.messages?.[0]?.id ?? undefined;
      if (!messageId) return { success: false, message: `No email found for "${query}".` };
    }

    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const headers = msg.data.payload?.headers || [];
    const subject = getHeader(headers, 'Subject') || '(no subject)';
    const from = getHeader(headers, 'From');
    const date = getHeader(headers, 'Date');

    let body = '';
    const payload = msg.data.payload;
    if (payload?.body?.data) {
      body = decodeBase64Url(payload.body.data);
    } else if (payload?.parts) {
      const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
      if (textPart?.body?.data) {
        body = decodeBase64Url(textPart.body.data);
      } else {
        const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
        if (htmlPart?.body?.data) {
          body = decodeBase64Url(htmlPart.body.data).replace(/<[^>]+>/g, '');
        }
      }
    }

    const output = `From: ${from}\nDate: ${date}\nSubject: ${subject}\n\n${body.trim()}`;
    return { success: true, message: output };
  }

  private async sendEmail(args: Record<string, string>): Promise<CommandResult> {
    const auth = getAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });
    const raw = args.raw || '';
    const to = args.to || '';

    if (!to) return { success: false, message: 'No recipient specified.' };

    let subject = '';
    let body = '';

    const subjectMatch = raw.match(/(?:subject|about|re)[:\s]+["']?([^"'\n]+)["']?/i);
    if (subjectMatch) {
      subject = subjectMatch[1].trim();
    }

    const bodyDraft = await llmStreamChat(
      [{ role: 'user', content: `Draft a concise email based on this request: "${raw}"\nTo: ${to}\nReturn ONLY the email body text, no subject line or headers.` }],
      'You are an email drafting assistant. Write professional, concise emails. Return only the body text.',
      () => {},
    );
    body = bodyDraft.trim();

    if (!subject) {
      subject = await llmStreamChat(
        [{ role: 'user', content: `Generate a short email subject line for this email body:\n${body}\nReturn ONLY the subject line, nothing else.` }],
        'Generate a concise email subject line.',
        () => {},
      );
      subject = subject.trim().replace(/^["']|["']$/g, '');
    }

    const emailLines = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      body,
    ];
    const encodedMessage = Buffer.from(emailLines.join('\r\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedMessage },
    });

    return { success: true, message: `Email sent to ${to}.\nSubject: ${subject}` };
  }

  private async searchEmails(args: Record<string, string>): Promise<CommandResult> {
    const auth = getAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });
    const query = args.query || '';

    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 10,
    });

    const messages = res.data.messages || [];
    if (messages.length === 0) {
      return { success: true, message: `No emails found for "${query}".` };
    }

    const details = await Promise.all(
      messages.map(async (m, i) => {
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id: m.id!,
          format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'Date'],
        });
        const headers = msg.data.payload?.headers || [];
        const subject = getHeader(headers, 'Subject') || '(no subject)';
        const from = getHeader(headers, 'From');
        const date = getHeader(headers, 'Date');
        return `${i + 1}. ${from} — ${date}\n   ${subject}`;
      })
    );

    return { success: true, message: `Search results for "${query}" (${messages.length}):\n\n${details.join('\n\n')}` };
  }

  getHelp(): string {
    return [
      '  Email (Gmail) — read, send, and search emails',
      '    inbox / check email    Show last 10 unread emails',
      '    read <n>               Read email by index',
      '    send email to <addr>   Compose and send email',
      '    search <query>         Search emails',
    ].join('\n');
  }
}
