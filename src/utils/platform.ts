/**
 * Platform Detection for JARVIS
 *
 * When JARVIS runs on a Linux VPS, macOS-specific features
 * (osascript, afplay, say, etc.) must be proxied to a connected
 * Mac client via AIM instead of executing locally.
 */

export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';

/**
 * Returns true if macOS commands need to be proxied to a Mac client.
 * This is the case when running on Linux (VPS).
 */
export function requireMacProxy(): boolean {
  return !IS_MAC;
}
