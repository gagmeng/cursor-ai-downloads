/**
 * Fill gaps in version-history.json from cn.cursorhistory.com.
 *
 * This repository only starts tracking at whatever version was current when it
 * was first deployed, and its scheduled job silently recorded nothing between
 * April 2025 and September 2026. cursorhistory has that stretch.
 *
 * Only URLs on Cursor's own download host are ingested. The site also mirrors
 * some very old releases in a Google Cloud Storage bucket whose billing account
 * has been closed, so every object there answers 403 — those are rejected by
 * host rather than written and then discovered to be dead.
 *
 * This is a one-off maintenance script, deliberately kept out of the hourly
 * workflow: it visits hundreds of a third party's pages and depends on their
 * availability and markup, neither of which should gate the scheduled update.
 *
 * Flags: --dry-run, --limit N, --concurrency N, --since X.Y.Z, --verbose
 */
import {
  readVersionHistory,
  saveVersionHistory,
  urlExists,
  mapLimit,
  upsertVersion,
  formatDate,
  SCHEMA_VERSION,
  type VersionHistoryEntry,
} from './utils.js';
import { fetchVersionIndex, fetchVersionLinks } from './cursorhistory.js';
import { toUserSetupUrl, PLATFORM_KEYS } from './platforms.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');
const CONCURRENCY = Number(args[args.indexOf('--concurrency') + 1]) || 3;
const LIMIT = Number(args[args.indexOf('--limit') + 1]) || Infinity;
const SINCE = args.includes('--since') ? args[args.indexOf('--since') + 1] : undefined;

/** Minimum platforms a fetched version must yield before it is trusted. */
const MIN_PLATFORMS = 5;

/** Compare dotted versions; negative when a < b. */
function cmp(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

interface Report {
  added: string[];
  skipped: { version: string; reason: string }[];
  failed: { version: string; reason: string }[];
}

async function main(): Promise<void> {
  const history = readVersionHistory();
  if (history.versions.length === 0) {
    throw new Error('version-history.json is missing or empty');
  }
  console.log(`History has ${history.versions.length} versions.`);

  const index = await fetchVersionIndex();
  console.log(`cursorhistory lists ${index.size} versions.`);

  const known = new Set(history.versions.map((e) => e.version));

  // Oldest first, so a partial run still leaves the history contiguous.
  let candidates = [...index.keys()]
    .filter((v) => !known.has(v))
    .sort(cmp);

  if (SINCE) candidates = candidates.filter((v) => cmp(v, SINCE) >= 0);
  console.log(`Missing: ${candidates.length}${SINCE ? ` (since ${SINCE})` : ''}.`);

  if (candidates.length > LIMIT) {
    console.log(`Limiting to ${LIMIT}.`);
    candidates = candidates.slice(0, LIMIT);
  }

  const report: Report = { added: [], skipped: [], failed: [] };
  const newEntries: VersionHistoryEntry[] = [];

  await mapLimit(candidates, CONCURRENCY, async (version) => {
    try {
      const { accepted, rejected } = await fetchVersionLinks(version);
      const keys = Object.keys(accepted);

      if (keys.length < MIN_PLATFORMS) {
        const reason = rejected.length
          ? `only ${keys.length} official links (rejected: ${[
              ...new Set(rejected.map((r) => r.reason)),
            ].join(', ')})`
          : `only ${keys.length} links found`;
        report.skipped.push({ version, reason });
        if (VERBOSE) console.log(`skip ${version}: ${reason}`);
        return;
      }

      // Verify rather than trust: the page can list a filename that was never
      // uploaded for that build.
      const checks = await mapLimit(keys, 4, async (k) => ({ k, ok: await urlExists(accepted[k]) }));
      const good = checks.filter((c) => c.ok).map((c) => c.k);

      if (good.length < MIN_PLATFORMS) {
        report.failed.push({ version, reason: `${good.length}/${keys.length} URLs resolved` });
        if (VERBOSE) console.log(`fail ${version}: ${good.length}/${keys.length} resolved`);
        return;
      }

      const platforms: Record<string, string> = {};
      for (const k of good) platforms[k] = accepted[k];

      // The site never lists the user installer; derive it from the system one.
      for (const arch of ['x64', 'arm64']) {
        const sys = platforms[`win32-${arch}`];
        if (!sys) continue;
        const user = toUserSetupUrl(sys);
        if (user && (await urlExists(user))) platforms[`win32-${arch}-user`] = user;
      }

      newEntries.push({
        version,
        date: index.get(version) || formatDate(new Date()),
        source: 'cursorhistory',
        platforms,
      });
      report.added.push(version);
      if (VERBOSE) console.log(`add  ${version}: ${Object.keys(platforms).length} platforms`);
    } catch (error) {
      report.failed.push({
        version,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });

  console.log(`\nadded ${report.added.length} / skipped ${report.skipped.length} / failed ${report.failed.length}`);

  if (report.skipped.length > 0) {
    console.log('\nSkipped (no usable official links):');
    for (const s of report.skipped) console.log(`  ${s.version.padEnd(10)} ${s.reason}`);
  }
  if (report.failed.length > 0) {
    console.log('\nFailed:');
    for (const f of report.failed) console.log(`  ${f.version.padEnd(10)} ${f.reason}`);
  }

  if (DRY_RUN || newEntries.length === 0) {
    console.log(DRY_RUN ? '\nDry run: nothing written.' : '\nNothing to add.');
    return;
  }

  for (const e of newEntries) upsertVersion(history, e);

  // Sanity check before writing: never let a mirror host slip in.
  for (const e of history.versions) {
    for (const [k, url] of Object.entries(e.platforms)) {
      if (url.includes('storage.googleapis.com')) {
        throw new Error(`refusing to write: ${e.version}/${k} points at the dead GCS mirror`);
      }
    }
  }

  history.schemaVersion = SCHEMA_VERSION;
  if (!saveVersionHistory(history, '.backfill-backup')) {
    throw new Error('failed to save version-history.json');
  }
  console.log(`\nversion-history.json now has ${history.versions.length} versions.`);
}

main().catch((error) => {
  console.error('Error backfilling from cursorhistory:', error instanceof Error ? error.message : error);
  process.exit(1);
});
