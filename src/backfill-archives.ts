/**
 * Record Internet Archive copies of downloads whose original host is gone.
 *
 * Every version up to 0.45.14 was recorded against downloader.cursor.sh, which
 * no longer resolves — the domain has been removed from DNS, so those 322 links
 * are dead for good. The Internet Archive captured roughly three quarters of
 * them, byte for byte, and those captures are still downloadable.
 *
 * The mapping is stored in the repository rather than looked up at render time:
 * a CDX query takes tens of seconds and the archive is unreliable enough that a
 * failed lookup would be indistinguishable from "no capture exists".
 *
 * Only URLs known to be dead are considered; a live link is never replaced.
 *
 * Flags: --dry-run, --force, --concurrency N, --verbose
 */
import {
  readVersionHistory,
  saveVersionHistory,
  urlExists,
  mapLimit,
  type VersionHistoryEntry,
} from './utils.js';
import { DEAD_HOSTS, hostOf } from './platforms.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const VERBOSE = args.includes('--verbose');
const CONCURRENCY = Number(args[args.indexOf('--concurrency') + 1]) || 4;

const INDEX_PREFIX = 'downloader.cursor.sh/builds';

interface Capture {
  timestamp: string;
  length: number;
}

/**
 * One CDX query for the whole dead host, rather than one per URL.
 *
 * `filter=statuscode:200` is essential: the index also holds 404 captures, and
 * without the filter those look like archives of downloads that never existed.
 */
async function fetchCdxIndex(attempts = 3): Promise<Map<string, Capture>> {
  const url =
    'https://web.archive.org/cdx/search/cdx' +
    `?url=${encodeURIComponent(INDEX_PREFIX)}` +
    '&matchType=prefix&output=json' +
    '&filter=statuscode:200&collapse=urlkey' +
    '&fl=original,timestamp,length';

  let lastError = '';
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      const wait = [2000, 6000, 15000][i - 1] ?? 15000;
      console.warn(`CDX retry ${i}/${attempts - 1} in ${wait}ms (${lastError})`);
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      const text = await res.text();
      // The archive serves an HTML "Temporarily Offline" page *with HTTP 200*,
      // so a JSON parse — not the status code — is what decides success.
      if (!text.trimStart().startsWith('[')) {
        throw new Error(`non-JSON CDX response: ${text.slice(0, 80)}`);
      }
      const rows = JSON.parse(text) as string[][];
      if (!Array.isArray(rows) || rows.length === 0) throw new Error('empty CDX response');

      const captures = new Map<string, Capture>();
      for (const row of rows.slice(1)) {
        const [original, timestamp, length] = row;
        if (!original || !timestamp) continue;
        const key = original.replace(/^https?:\/\//, '');
        const previous = captures.get(key);
        // Keep the newest capture: older ones are likelier to be truncated.
        if (!previous || timestamp > previous.timestamp) {
          captures.set(key, { timestamp, length: Number(length) || 0 });
        }
      }
      return captures;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`CDX index unavailable after ${attempts} attempts: ${lastError}`);
}

/** Build the replay URL. `id_` returns the original bytes and honours Range. */
function archiveUrl(timestamp: string, original: string): string {
  return `https://web.archive.org/web/${timestamp}id_/${original}`;
}

async function main(): Promise<void> {
  const history = readVersionHistory();
  if (history.versions.length === 0) throw new Error('version-history.json is missing or empty');

  // Only dead-hosted links with no archive recorded yet (unless --force).
  const targets: { entry: VersionHistoryEntry; platform: string; url: string }[] = [];
  for (const entry of history.versions) {
    for (const [platform, url] of Object.entries(entry.platforms)) {
      if (!DEAD_HOSTS.includes(hostOf(url))) continue;
      if (!FORCE && entry.archives?.[platform]) continue;
      targets.push({ entry, platform, url });
    }
  }

  console.log(`Dead links needing an archive: ${targets.length}`);
  if (targets.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  console.log('Querying the Internet Archive CDX index...');
  const captures = await fetchCdxIndex();
  console.log(`CDX index holds ${captures.size} captures under ${INDEX_PREFIX}.`);

  const candidates = targets
    .map((t) => ({ ...t, capture: captures.get(t.url.replace(/^https?:\/\//, '')) }))
    .filter((t) => t.capture) as (typeof targets[number] & { capture: Capture })[];

  console.log(`Capture found for ${candidates.length}/${targets.length}.`);

  // A CDX row proves a capture existed, not that it still replays.
  const checked = await mapLimit(candidates, CONCURRENCY, async (t) => ({
    ...t,
    ok: await urlExists(archiveUrl(t.capture.timestamp, t.url), 30000),
  }));

  const good = checked.filter((t) => t.ok);
  const dead = checked.filter((t) => !t.ok);
  console.log(`Verified reachable: ${good.length}; ${dead.length} failed verification.`);

  if (DRY_RUN) {
    for (const t of good.slice(0, 20)) {
      console.log(`  ${t.entry.version.padEnd(10)} ${t.platform.padEnd(17)} ${archiveUrl(t.capture.timestamp, t.url)}`);
    }
    if (good.length > 20) console.log(`  ... and ${good.length - 20} more`);
    console.log('Dry run: nothing written.');
    return;
  }

  const entryByVersion = new Map(history.versions.map((e) => [e.version, e]));
  let applied = 0;
  for (const t of good) {
    const entry = entryByVersion.get(t.entry.version) as VersionHistoryEntry;
    entry.archives = entry.archives ?? {};
    entry.archives[t.platform] = archiveUrl(t.capture.timestamp, t.url);
    applied++;
  }

  // --force re-checks existing entries; drop the ones that no longer replay.
  let removed = 0;
  if (FORCE) {
    for (const entry of history.versions) {
      if (!entry.archives) continue;
      for (const platform of Object.keys(entry.archives)) {
        const t = targets.find((x) => x.entry.version === entry.version && x.platform === platform);
        if (t && !good.some((g) => g.entry.version === entry.version && g.platform === platform)) {
          delete entry.archives[platform];
          removed++;
        }
      }
      if (Object.keys(entry.archives).length === 0) delete entry.archives;
    }
  }

  if (applied === 0 && removed === 0) {
    console.log('Nothing applied; file left untouched.');
    return;
  }

  if (!saveVersionHistory(history, '.archives-backup')) {
    throw new Error('failed to save version-history.json');
  }
  console.log(`Applied ${applied} archives${removed ? `, removed ${removed}` : ''}.`);
}

main().catch((error) => {
  console.error('Error building archive map:', error instanceof Error ? error.message : error);
  // Never write a partial map: that is how a temporary outage would turn into
  // permanently missing archives.
  process.exit(1);
});
