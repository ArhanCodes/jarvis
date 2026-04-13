/**
 * Breach Monitor — Always-on background service
 *
 * Continuously monitors your domains and accounts for security issues:
 * - SSL certificate expiry (warns 14 days before)
 * - Domain HTTP health checks
 * - Have I Been Pwned email breach lookups
 *
 * Runs automatically when JARVIS boots. No activation needed.
 */

import { fmt } from './formatter.js';
import { speak } from './voice-output.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from './logger.js';
import { readJsonConfig, writeJsonConfig } from './config.js';

const execAsync = promisify(exec);
const log = createLogger('breach-monitor');

// ── Config ──

interface BreachConfig {
  domains: string[];
  emails: string[];
  checkIntervalMinutes: number;
}

const DEFAULT_CONFIG: BreachConfig = {
  domains: ['mytradebuddy.com', 'rewovenapp.com', 'arhan.dev'],
  emails: [],
  checkIntervalMinutes: 60,
};

interface BreachState {
  lastCheck: string | null;
  alerts: { time: string; type: string; message: string }[];
  sslExpiry: Record<string, string>; // domain → expiry date ISO
  knownBreaches: string[]; // already-alerted breach IDs
}

function loadConfig(): BreachConfig {
  const loaded = readJsonConfig<Partial<BreachConfig>>('breach-monitor.json', {});
  if (Object.keys(loaded).length === 0) {
    // Write default config on first run
    writeJsonConfig('breach-monitor.json', DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
  return { ...DEFAULT_CONFIG, ...loaded };
}

function loadState(): BreachState {
  return readJsonConfig<BreachState>('breach-state.json', { lastCheck: null, alerts: [], sslExpiry: {}, knownBreaches: [] });
}

function saveState(state: BreachState): void {
  // Keep last 100 alerts
  if (state.alerts.length > 100) state.alerts = state.alerts.slice(-100);
  writeJsonConfig('breach-state.json', state);
}

// ── SSL Certificate Check ──

async function checkSSL(domain: string): Promise<{ valid: boolean; expiryDate: Date | null; daysLeft: number; error?: string }> {
  try {
    const { stdout } = await execAsync(
      `echo | openssl s_client -servername ${domain} -connect ${domain}:443 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null`,
      { timeout: 15000 },
    );
    const match = stdout.match(/notAfter=(.+)/);
    if (match) {
      const expiryDate = new Date(match[1]);
      const daysLeft = Math.floor((expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      return { valid: daysLeft > 0, expiryDate, daysLeft };
    }
    return { valid: false, expiryDate: null, daysLeft: -1, error: 'Could not parse certificate' };
  } catch (err) {
    return { valid: false, expiryDate: null, daysLeft: -1, error: (err as Error).message };
  }
}

// ── Domain Health Check ──

async function checkDomainHealth(domain: string): Promise<{ reachable: boolean; statusCode: number; responseTime: number }> {
  const start = Date.now();
  try {
    const resp = await fetch(`https://${domain}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(10000),
    });
    return { reachable: true, statusCode: resp.status, responseTime: Date.now() - start };
  } catch (err) {
    log.debug(`HTTPS check failed for ${domain}`, err);
    // Try http as fallback
    try {
      const resp = await fetch(`http://${domain}`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(10000),
      });
      return { reachable: true, statusCode: resp.status, responseTime: Date.now() - start };
    } catch (err2) {
      log.debug(`HTTP fallback check failed for ${domain}`, err2);
      return { reachable: false, statusCode: 0, responseTime: Date.now() - start };
    }
  }
}

// ── Have I Been Pwned Check ──

async function checkHIBP(email: string): Promise<{ breached: boolean; breaches: string[] }> {
  try {
    const resp = await fetch(
      `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=true`,
      {
        headers: { 'User-Agent': 'JARVIS-BreachMonitor' },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (resp.status === 200) {
      const data = (await resp.json()) as { Name: string }[];
      return { breached: true, breaches: data.map(b => b.Name) };
    }
    return { breached: false, breaches: [] };
  } catch (err) {
    log.debug(`HIBP check failed for ${email}`, err);
    return { breached: false, breaches: [] };
  }
}

// ── Alert System ──

function alert(message: string, type: 'warning' | 'critical', state: BreachState): void {
  const prefix = type === 'critical' ? '🚨' : '⚠️';
  console.log('');
  console.log(fmt.warn(`${prefix} [BREACH MONITOR] ${message}`));
  console.log('');

  state.alerts.push({ time: new Date().toISOString(), type, message });

  // Speak critical alerts
  if (type === 'critical') {
    speak(`Security alert. ${message}`).catch(() => {});
  }
}

// ── Main Check Cycle ──

async function runFullCheck(): Promise<void> {
  const config = loadConfig();
  const state = loadState();

  // Check SSL certificates — only alert if expiring or expired
  for (const domain of config.domains) {
    const ssl = await checkSSL(domain);

    if (!ssl.error) {
      if (!ssl.valid) {
        alert(`SSL certificate for ${domain} has EXPIRED!`, 'critical', state);
      } else if (ssl.daysLeft <= 7) {
        alert(`SSL certificate for ${domain} expires in ${ssl.daysLeft} days!`, 'critical', state);
      } else if (ssl.daysLeft <= 14) {
        alert(`SSL certificate for ${domain} expires in ${ssl.daysLeft} days. Renew soon.`, 'warning', state);
      }

      if (ssl.expiryDate) {
        state.sslExpiry[domain] = ssl.expiryDate.toISOString();
      }
    }
  }

  // Check domain reachability — only alert if DOWN or erroring
  for (const domain of config.domains) {
    const health = await checkDomainHealth(domain);

    if (!health.reachable) {
      alert(`${domain} is DOWN and unreachable!`, 'critical', state);
    } else if (health.statusCode >= 500) {
      alert(`${domain} is returning server errors (HTTP ${health.statusCode})`, 'critical', state);
    }
    // Don't log anything when sites are healthy — silence is good
  }

  // Check emails for breaches
  for (const email of config.emails) {
    const result = await checkHIBP(email);
    if (result.breached) {
      const newBreaches = result.breaches.filter(b => !state.knownBreaches.includes(`${email}:${b}`));
      if (newBreaches.length > 0) {
        alert(
          `Email ${email} found in ${newBreaches.length} NEW breach(es): ${newBreaches.join(', ')}. Change your passwords immediately!`,
          'critical',
          state,
        );
        state.knownBreaches.push(...newBreaches.map(b => `${email}:${b}`));
      }
    }
  }

  state.lastCheck = new Date().toISOString();
  saveState(state);
}

// ── Public API ──

let checkTimer: NodeJS.Timeout | null = null;

export function startBreachMonitor(): void {
  const config = loadConfig();

  // Run first check after 30 seconds (let JARVIS boot quietly first)
  setTimeout(() => {
    runFullCheck().catch(() => {});
  }, 30_000);

  // Then run on interval — silently
  checkTimer = setInterval(() => {
    runFullCheck().catch(() => {});
  }, config.checkIntervalMinutes * 60 * 1000);
}

export function stopBreachMonitor(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

/** Get a summary of the current breach monitor status */
export function getBreachStatus(): string {
  const config = loadConfig();
  const state = loadState();
  const lines: string[] = [];

  lines.push('Breach Monitor Status');
  lines.push(`  Monitoring: ${config.domains.join(', ')}`);
  lines.push(`  Last check: ${state.lastCheck ? new Date(state.lastCheck).toLocaleString() : 'Never'}`);

  if (Object.keys(state.sslExpiry).length > 0) {
    lines.push('  SSL Certificates:');
    for (const [domain, expiry] of Object.entries(state.sslExpiry)) {
      const days = Math.floor((new Date(expiry).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      const status = days <= 7 ? '🔴' : days <= 14 ? '🟡' : '🟢';
      lines.push(`    ${status} ${domain} — ${days} days left`);
    }
  }

  const recentAlerts = state.alerts.slice(-5);
  if (recentAlerts.length > 0) {
    lines.push('  Recent alerts:');
    for (const a of recentAlerts) {
      lines.push(`    [${new Date(a.time).toLocaleString()}] ${a.message}`);
    }
  } else {
    lines.push('  No recent alerts ✓');
  }

  return lines.join('\n');
}

/** Force a manual check right now */
export async function runManualCheck(): Promise<string> {
  await runFullCheck();
  return getBreachStatus();
}
