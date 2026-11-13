/**
 * Probe Cursor's download API for the current release and record it.
 *
 * Responsibilities are deliberately narrow: fetch, deduplicate against
 * version-history.json, and write. README.md and the site are generated from
 * that file by `update-readme-from-history.ts`; this script never edits either.
 *
 * Flags: --verbose
 */
import * as fs from 'fs';
import {
  readVersionHistory,
  saveVersionHistory,
  compareVersions,
  sortVersionsDesc,
  extractVersion,
  formatDate,
  urlExists,
  mapLimit,
  SCHEMA_VERSION,
  type VersionHistoryEntry,
} from './utils.js';
import { API_PLATFORMS, toUserSetupUrl } from './platforms.js';

// Global Response type is available via "dom" lib in tsconfig

interface VersionInfo {
  url: string;
  version: string;
}

interface DownloadResponse {
  downloadUrl: string;
  version?: string;
}

/** Upper bound on stored history, well above the real size. */
const MAX_HISTORY = 1000;

/** Platform used to detect whether a new release exists at all. */
const PROBE_PLATFORM = 'darwin-universal';

const VERBOSE = process.argv.includes('--verbose');

/** Emit a GitHub Actions output without relying on a shell pipeline. */
function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) {
    fs.appendFileSync(file, `${name}=${value}\n`);
  } else {
    console.log(`${name}=${value}`);
  }
}

/**
 * Fetch the latest download URL for one platform.
 * Returns null on any failure; the caller decides whether that is fatal.
 */
async function fetchLatestDownloadUrl(platform: string): Promise<VersionInfo | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(
      `https://cursor.com/api/download?platform=${platform}&releaseTrack=latest`,
      {
        headers: {
          'User-Agent': 'Cursor-Version-Checker',
          'Cache-Control': 'no-cache',
        },
        signal: controller.signal,
      },
    );

    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

    const data = (await response.json()) as DownloadResponse;
    if (!data.downloadUrl) throw new Error('response has no downloadUrl');

    // Download file names no longer carry the version, so the API's own field
    // is authoritative and extractVersion() is only a fallback.
    return { url: data.downloadUrl, version: data.version || extractVersion(data.downloadUrl) };
  } catch (error) {
    console.error(
      `Error fetching download URL for platform ${platform}:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch every platform for a release, in parallel.
 *
 * The probe platform is fetched first: when it reports a version that is
 * already recorded — the common case on an hourly schedule — there is no
 * reason to issue six more requests.
 */
async function fetchLatestRelease(): Promise<{ version: string; platforms: Record<string, string> } | null> {
  const probe = await fetchLatestDownloadUrl(PROBE_PLATFORM);
  if (!probe) {
    // Fall back to the full sweep: a single platform failing now and then is
    // not a reason to skip an entire update.
    console.warn(`Probe platform ${PROBE_PLATFORM} failed; fetching all platforms.`);
  }

  const platforms = [PROBE_PLATFORM, ...API_PLATFORMS.filter((p) => p !== PROBE_PLATFORM)];
  const results = await mapLimit(platforms, 6, async (platform) =>
    platform === PROBE_PLATFORM && probe ? probe : fetchLatestDownloadUrl(platform),
  );

  let version = '0.0.0';
  const urls: Record<string, string> = {};

  platforms.forEach((platform, i) => {
    const info = results[i];
    if (!info) return;
    urls[platform] = info.url;
    if (info.version !== 'Unknown' && compareVersions(info.version, version) > 0) {
      version = info.version;
    }
  });

  if (version === '0.0.0') return null;
  return { version, platforms: urls };
}

/**
 * Consistency checks on the data file itself.
 *
 * Replaces the old "recover from README.md" path: generating the README from
 * this file and then parsing the README back into it could only ever return
 * what was just written, at the cost of a lossy HTML round trip.
 */
function assertInvariants(history: ReturnType<typeof readVersionHistory>): void {
  if (history.versions.length === 0) {
    throw new Error('version-history.json contains no versions');
  }

  const seen = new Set<string>();
  for (const entry of history.versions) {
    if (seen.has(entry.version)) throw new Error(`duplicate version ${entry.version}`);
    seen.add(entry.version);

    if (!/^\d+\.\d+\.\d+$/.test(entry.version)) {
      throw new Error(`malformed version "${entry.version}"`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
      throw new Error(`malformed date "${entry.date}" on ${entry.version}`);
    }

    for (const [platform, url] of Object.entries(entry.platforms)) {
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
        throw new Error(`bad url for ${entry.version}/${platform}: ${url}`);
      }
    }
    for (const platform of Object.keys(entry.archives ?? {})) {
      if (!(platform in entry.platforms)) {
        throw new Error(`archive without a matching platform: ${entry.version}/${platform}`);
      }
    }
  }

  for (let i = 1; i < history.versions.length; i++) {
    if (compareVersions(history.versions[i - 1].version, history.versions[i].version) < 0) {
      throw new Error(
        `history is not sorted: ${history.versions[i - 1].version} before ${history.versions[i].version}`,
      );
    }
  }
}

/**
 * Record the release in history if it is new.
 * Returns true when a new version was written.
 */
async function updateHistory(): Promise<boolean> {
  const release = await fetchLatestRelease();
  if (!release) {
    console.error('Failed to retrieve any valid version information');
    return false;
  }

  if (VERBOSE) console.log(`Latest version detected: ${release.version}`);

  const history = readVersionHistory();
  if (history.versions.some((entry) => entry.version === release.version)) {
    return false;
  }

  // Derive the user installer from the system installer, and store it only if
  // it really exists for this build.
  for (const arch of ['x64', 'arm64']) {
    const userUrl = toUserSetupUrl(release.platforms[`win32-${arch}`] ?? '');
    if (userUrl && (await urlExists(userUrl))) {
      release.platforms[`win32-${arch}-user`] = userUrl;
    }
  }

  const newEntry: VersionHistoryEntry = {
    version: release.version,
    date: formatDate(new Date()),
    source: 'api',
    platforms: release.platforms,
  };

  history.versions.push(newEntry);
  sortVersionsDesc(history);

  if (history.versions.length > MAX_HISTORY) {
    history.versions = history.versions.slice(0, MAX_HISTORY);
  }

  history.schemaVersion = SCHEMA_VERSION;
  assertInvariants(history);

  if (!saveVersionHistory(history, '.update-backup')) {
    throw new Error('failed to save version-history.json');
  }

  console.log(`Recorded ${release.version} in version-history.json`);
  return true;
}

async function main(): Promise<void> {
  try {
    const updated = await updateHistory();
    // Re-read and validate what is actually on disk, so a write that silently
    // produced something unusable fails the run instead of the next one.
    assertInvariants(readVersionHistory());
    setOutput('update_result', String(updated));
  } catch (error) {
    console.error(
      'Critical error during update process:',
      error instanceof Error ? error.message : 'Unknown error',
    );
    // A non-zero exit marks the workflow step as failed.
    process.exit(1);
  }
}

// Export functions for testing
export { fetchLatestDownloadUrl, updateHistory, main };

// Keep execution logic if this script is run directly
main();
