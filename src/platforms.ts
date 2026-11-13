/**
 * Single source of truth for platform keys and the order they are presented in.
 *
 * `docs/script.js` is plain browser JavaScript with no build step, so it cannot
 * import from here; its table header and row template must list the same keys
 * in the same order. Keep both in sync when adding a platform.
 */

export interface Column {
  /** Key into `VersionHistoryEntry.platforms`. */
  key: string;
  /** Header text used in README.md and on the site. */
  label: string;
  /** Display group; used for the latest-version summary. */
  group: 'mac' | 'win' | 'linux';
}

/** Display order. System installers first, then their user-installer variants. */
export const COLUMNS: Column[] = [
  { key: 'darwin-universal', label: 'macOS Universal', group: 'mac' },
  { key: 'darwin-x64', label: 'macOS Intel', group: 'mac' },
  { key: 'darwin-arm64', label: 'macOS Apple Silicon', group: 'mac' },
  { key: 'win32-x64', label: 'Windows x64', group: 'win' },
  { key: 'win32-x64-user', label: 'Windows x64 (user)', group: 'win' },
  { key: 'win32-arm64', label: 'Windows ARM64', group: 'win' },
  { key: 'win32-arm64-user', label: 'Windows ARM64 (user)', group: 'win' },
  { key: 'linux-x64', label: 'Linux x64', group: 'linux' },
  { key: 'linux-arm64', label: 'Linux ARM64', group: 'linux' },
];

/** Every platform key the project knows about. */
export const PLATFORM_KEYS: string[] = COLUMNS.map((c) => c.key);

/** Platforms fetched from Cursor's own download API (it has no user-setup). */
export const API_PLATFORMS: string[] = [
  'win32-x64',
  'win32-arm64',
  'darwin-universal',
  'darwin-x64',
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
];

/**
 * Derive the Windows User Installer URL from the System Installer URL.
 *
 *   .../win32/x64/system-setup/CursorSetup-x64-3.30.8.exe
 *   .../win32/x64/user-setup/CursorUserSetup-x64-3.30.8.exe
 *
 * Returns null when the input does not look like a system-setup URL, so callers
 * never build a plausible-looking but wrong link.
 */
export function toUserSetupUrl(systemUrl: string): string | null {
  if (!/\/win32\/(x64|arm64)\/system-setup\/CursorSetup-/.test(systemUrl)) return null;
  return systemUrl.replace('/system-setup/CursorSetup-', '/user-setup/CursorUserSetup-');
}

/** Inverse of {@link toUserSetupUrl}. Returns null for non user-setup URLs. */
export function toSystemSetupUrl(userUrl: string): string | null {
  if (!/\/win32\/(x64|arm64)\/user-setup\/CursorUserSetup-/.test(userUrl)) return null;
  return userUrl.replace('/user-setup/CursorUserSetup-', '/system-setup/CursorSetup-');
}

/** Move an anysphere S3 URL onto the official downloads.cursor.com host. */
export function s3ToDownloads(url: string): string {
  return url.replace(
    /^https:\/\/anysphere-binaries\.s3\.[a-z0-9-]+\.amazonaws\.com\//,
    'https://downloads.cursor.com/',
  );
}

/** Hosts that no longer resolve or no longer serve files. */
export const DEAD_HOSTS = ['downloader.cursor.sh'];

/** Hosts accepted as a source of official download links. */
export const OFFICIAL_HOSTS = ['downloads.cursor.com'];

/** Extract the host name of a URL, or '' when unparsable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
