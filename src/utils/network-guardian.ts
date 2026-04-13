/**
 * Smart Home Guardian — Always-on network monitoring service
 *
 * Continuously scans your local network for devices.
 * Alerts you immediately when an unknown device connects.
 * You can trust devices so they stop triggering alerts.
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
const log = createLogger('network-guardian');

// ── Types ──

interface NetworkDevice {
  ip: string;
  mac: string;
  hostname?: string;
  vendor?: string;
  firstSeen: string;
  lastSeen: string;
  trusted: boolean;
  label?: string; // user-friendly name like "Arhan's iPhone"
}

interface GuardianState {
  devices: NetworkDevice[];
  scanCount: number;
  lastScan: string | null;
  alerts: { time: string; mac: string; ip: string; message: string }[];
}

// ── Config ──

interface GuardianConfig {
  scanIntervalMinutes: number;
  alertOnNewDevices: boolean;
  autoTrustAfterScans: number; // auto-trust after seen this many scans (0 = never)
  homeSSIDs: string[]; // only scan when connected to these WiFi networks
}

const DEFAULT_CONFIG: GuardianConfig = {
  scanIntervalMinutes: 5,
  alertOnNewDevices: true,
  autoTrustAfterScans: 0,
  homeSSIDs: ['TP-Link'],
};

function loadConfig(): GuardianConfig {
  const loaded = readJsonConfig<Partial<GuardianConfig>>('network-guardian.json', {});
  if (Object.keys(loaded).length === 0) {
    writeJsonConfig('network-guardian.json', DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
  return { ...DEFAULT_CONFIG, ...loaded };
}

function loadState(): GuardianState {
  return readJsonConfig<GuardianState>('network-devices.json', { devices: [], scanCount: 0, lastScan: null, alerts: [] });
}

function saveState(state: GuardianState): void {
  // Keep last 200 alerts
  if (state.alerts.length > 200) state.alerts = state.alerts.slice(-200);
  writeJsonConfig('network-devices.json', state);
}

// ── OUI Vendor Lookup (common prefixes) ──

const VENDOR_MAP: Record<string, string> = {
  '00:50:56': 'VMware',
  'a4:83:e7': 'Apple',
  '3c:22:fb': 'Apple',
  'f0:18:98': 'Apple',
  'ac:de:48': 'Apple',
  'd0:03:4b': 'Apple',
  '8c:85:90': 'Apple',
  '14:7d:da': 'Apple',
  '6c:94:66': 'Apple',
  '38:f9:d3': 'Apple',
  'dc:a6:32': 'Raspberry Pi',
  'b8:27:eb': 'Raspberry Pi',
  '00:1a:79': 'Google/Nest',
  'f4:f5:d8': 'Google',
  '54:60:09': 'Google',
  '30:fd:38': 'Google',
  '44:07:0b': 'Google',
  '18:b4:30': 'Nest',
  '64:16:66': 'Nest',
  '94:b9:7e': 'Amazon',
  'fc:65:de': 'Amazon',
  '74:c2:46': 'Amazon',
  '40:b4:cd': 'Amazon',
  '68:54:fd': 'Amazon',
  '00:04:20': 'Philips Hue',
  'ec:b5:fa': 'Philips Hue',
  '00:17:88': 'Philips Hue',
  '90:61:ae': 'Samsung',
  'cc:6e:a4': 'Samsung',
  '8c:79:f5': 'Samsung',
  'b4:69:21': 'Intel',
  '3c:97:0e': 'Intel',
  '00:1e:c2': 'Mediatrix',
  'e8:48:b8': 'TP-Link',
  '50:c7:bf': 'TP-Link',
  'c0:06:c3': 'TP-Link',
  '00:0c:43': 'Ralink',
  '00:26:f2': 'Netgear',
  'c4:3d:c7': 'Netgear',
  '20:e5:2a': 'Netgear',
  '38:94:96': 'Ring',
  '7c:64:56': 'Ring',
};

function lookupVendor(mac: string): string | undefined {
  const prefix = mac.toLowerCase().substring(0, 8);
  return VENDOR_MAP[prefix];
}

// ── ARP Scan ──

async function scanARP(): Promise<{ ip: string; mac: string; hostname?: string }[]> {
  const devices: { ip: string; mac: string; hostname?: string }[] = [];

  try {
    const { stdout } = await execAsync('arp -a', { timeout: 10000 });
    const lines = stdout.split('\n');

    for (const line of lines) {
      // macOS format: hostname (ip) at mac on interface [ifscope ...]
      // Linux format: hostname (ip) at mac [ether] on interface
      const match = line.match(/([^\s]+)\s+\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-f:]+)/i);
      if (match) {
        const mac = match[3].toLowerCase();
        if (mac === 'ff:ff:ff:ff:ff:ff' || mac === '(incomplete)') continue;

        devices.push({
          ip: match[2],
          mac,
          hostname: match[1] !== '?' ? match[1] : undefined,
        });
      }
    }
  } catch (err) {
    console.log(fmt.dim(`  [network-guardian] ARP scan failed: ${(err as Error).message}`));
  }

  return devices;
}

// ── WiFi SSID Check ──

async function getCurrentSSID(): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -I | awk '/ SSID/ {print substr($0, index($0, $2))}'`,
      { timeout: 5000 },
    );
    return stdout.trim() || null;
  } catch (err) {
    log.debug('Failed to get current SSID', err);
    return null;
  }
}

// ── Main Scan Cycle ──

async function runNetworkScan(): Promise<void> {
  const config = loadConfig();

  // Only scan on home WiFi networks
  if (config.homeSSIDs.length > 0) {
    const ssid = await getCurrentSSID();
    if (!ssid || !config.homeSSIDs.some(h => ssid.toLowerCase().includes(h.toLowerCase()))) {
      return; // Not on home network — skip scan silently
    }
  }

  const state = loadState();
  const now = new Date().toISOString();
  const isFirstScan = state.scanCount === 0;

  const arpDevices = await scanARP();

  if (arpDevices.length === 0) return;

  let newDeviceCount = 0;

  for (const arp of arpDevices) {
    const existing = state.devices.find(d => d.mac === arp.mac);

    if (existing) {
      // Known device — update last seen
      existing.lastSeen = now;
      existing.ip = arp.ip; // IP might change (DHCP)
      if (arp.hostname && !existing.hostname) existing.hostname = arp.hostname;
    } else {
      // NEW device detected!
      const vendor = lookupVendor(arp.mac);
      const device: NetworkDevice = {
        ip: arp.ip,
        mac: arp.mac,
        hostname: arp.hostname,
        vendor,
        firstSeen: now,
        lastSeen: now,
        // Auto-trust everything on first scan — these are your existing devices
        trusted: isFirstScan,
      };

      state.devices.push(device);
      newDeviceCount++;

      // Only alert on NEW devices after the initial baseline scan
      if (!isFirstScan && config.alertOnNewDevices) {
        const identifier = vendor
          ? `${vendor} device`
          : arp.hostname
            ? arp.hostname
            : 'Unknown device';

        const message = `New device on network: ${identifier} (${arp.ip}, MAC: ${arp.mac})`;

        console.log('');
        console.log(fmt.warn(`🛡️  [NETWORK GUARDIAN] ${message}`));
        console.log(fmt.dim(`     Trust it: jarvis trust device ${arp.mac}`));
        console.log('');

        state.alerts.push({ time: now, mac: arp.mac, ip: arp.ip, message });

        // Speak alert for ALL new unknown devices
        speak(`Network alert. Unknown device connected. ${identifier} at ${arp.ip}`).catch(() => {});
      }
    }
  }

  state.scanCount++;
  state.lastScan = now;
  saveState(state);

  if (isFirstScan) {
    console.log(fmt.dim(`  [network-guardian] Baseline scan complete — trusted ${arpDevices.length} existing devices`));
  }
}

// ── Public API ──

let scanTimer: NodeJS.Timeout | null = null;

export function startNetworkGuardian(): void {
  const config = loadConfig();

  // First scan after 20 seconds — establishes baseline silently
  setTimeout(() => {
    runNetworkScan().catch(() => {});
  }, 20_000);

  // Then on interval — silently
  scanTimer = setInterval(() => {
    runNetworkScan().catch(() => {});
  }, config.scanIntervalMinutes * 60 * 1000);
}

export function stopNetworkGuardian(): void {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}

/** Trust a device by MAC address so it no longer triggers alerts */
export function trustDevice(mac: string, label?: string): string {
  const state = loadState();
  const device = state.devices.find(d => d.mac.toLowerCase() === mac.toLowerCase());

  if (!device) {
    return `No device found with MAC ${mac}. Run a network scan first.`;
  }

  device.trusted = true;
  if (label) device.label = label;
  saveState(state);

  const name = label || device.vendor || device.hostname || device.mac;
  return `Trusted: ${name} (${device.ip})`;
}

/** Get list of all known devices */
export function getNetworkDevices(): string {
  const state = loadState();
  const lines: string[] = [];

  lines.push('Network Devices');
  lines.push(`  Total known: ${state.devices.length}`);
  lines.push(`  Last scan: ${state.lastScan ? new Date(state.lastScan).toLocaleString() : 'Never'}`);
  lines.push('');

  // Sort: untrusted first, then by last seen
  const sorted = [...state.devices].sort((a, b) => {
    if (a.trusted !== b.trusted) return a.trusted ? 1 : -1;
    return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
  });

  for (const d of sorted) {
    const status = d.trusted ? '✅' : '❓';
    const name = d.label || d.vendor || d.hostname || 'Unknown';
    const age = timeSince(d.lastSeen);
    lines.push(`  ${status} ${name} — ${d.ip} (${d.mac}) — last seen ${age}`);
  }

  const recentAlerts = state.alerts.slice(-5);
  if (recentAlerts.length > 0) {
    lines.push('');
    lines.push('  Recent alerts:');
    for (const a of recentAlerts) {
      lines.push(`    [${new Date(a.time).toLocaleString()}] ${a.message}`);
    }
  }

  return lines.join('\n');
}

function timeSince(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Force a manual scan now */
export async function runManualScan(): Promise<string> {
  await runNetworkScan();
  return getNetworkDevices();
}
