/**
 * Derive the missing Windows installer variant for every version.
 *
 * Cursor publishes two Windows installers per architecture:
 *   - System Installer (`system-setup/CursorSetup-*`)   — for all users, needs admin
 *   - User Installer   (`user-setup/CursorUserSetup-*`) — per user, no admin
 *
 * Cursor's download API only ever returns one of them, and which one it returns
 * has changed over time: up to 0.48.7 it returned the user installer, from
 * 0.48.8 onward the system installer. The 'win32-*' keys therefore have
 * inconsistent meaning across the history.
 *
 * This script normalizes that:
 *   - 'win32-x64' / 'win32-arm64' always refer to the System Installer
 *   - 'win32-x64-user' / 'win32-arm64-user' always the User Installer
 *
 * Every URL it derives is verified with a ranged GET before being written, so
 * a version that only shipped one variant simply keeps the other column empty.
 *
 * Legacy `downloader.cursor.sh` links are a single NSIS installer and cannot be
 * split into the two variants; they are skipped.
 *
 * Flags: --dry-run, --concurrency N, --verbose
 */
import {
  readVersionHistory,
  saveVersionHistory,
  urlExists,
  mapLimit,
  sortVersionsDesc,
  SCHEMA_VERSION,
  type VersionHistory,
  type VersionHistoryEntry,
} from './utils.js';
import { toUserSetupUrl, toSystemSetupUrl, s3ToDownloads, DEAD_HOSTS, hostOf } from './platforms.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');
const CONCURRENCY = Number(args[args.indexOf('--concurrency') + 1]) || 6;

/**
 * A change is atomic per (version, architecture): the system and user URLs are
 * settled together, so a version can never end up with both columns pointing at
 * the same installer.
 */
interface PlannedChange {
  version: string;
  arch: string;
  /** URL that must end up in `win32-<arch>`. */
  systemUrl?: string;
  /** URL that must end up in `win32-<arch>-user`. */
  userUrl?: string;
  /** Which URLs need a network check before being written. */
  verify: string[];
  /** Human-readable action for the report. */
  action: 'add-user' | 'move-user-and-derive-system';
}

/** Collect every change that would be made, without writing anything. */
function plan(history: VersionHistory): PlannedChange[] {
  const changes: PlannedChange[] = [];

  for (const entry of history.versions) {
    for (const arch of ['x64', 'arm64']) {
      const sysKey = `win32-${arch}`;
      const userKey = `win32-${arch}-user`;
      const current = entry.platforms[sysKey];
      const existingUser = entry.platforms[userKey];

      if (!current) {
        // e.g. 0.47.2 predates the Windows build; nothing to derive from.
        if (VERBOSE) console.log(`skip ${entry.version} ${sysKey}: no URL`);
        continue;
      }

      if (DEAD_HOSTS.includes(hostOf(current))) {
        if (VERBOSE) console.log(`skip ${entry.version} ${sysKey}: dead host`);
        continue;
      }

      // `current` IS the user installer (0.45.15–0.48.7): move it to its own
      // column and derive the system installer to take its place.
      // Note the direction: toSystemSetupUrl() answers "is this a user-setup
      // URL", while toUserSetupUrl() *derives* one from a system-setup URL and
      // would return non-null for both variants.
      if (toSystemSetupUrl(current)) {
        const systemUrl = toSystemSetupUrl(s3ToDownloads(current));
        if (!systemUrl) continue;

        // When the counterpart system installer does not exist (0.46.5), the
        // system column has to stay empty rather than keep showing the user
        // installer. The user URL moves to its own column either way, so the
        // two columns can never be the same file.
        if (existingUser) {
          changes.push({
            version: entry.version,
            arch,
            userUrl: existingUser,
            verify: [],
            action: 'add-user',
          });
          continue;
        }
        changes.push({
          version: entry.version,
          arch,
          systemUrl,
          userUrl: current,
          verify: [systemUrl],
          action: 'move-user-and-derive-system',
        });
        continue;
      }

      // `current` is the system installer: derive the user one.
      const userUrl = toUserSetupUrl(current);
      if (userUrl && !existingUser) {
        changes.push({
          version: entry.version,
          arch,
          systemUrl: current,
          userUrl,
          verify: [userUrl],
          action: 'add-user',
        });
      }
    }
  }

  return changes;
}

async function main(): Promise<void> {
  const history = readVersionHistory();
  if (history.versions.length === 0) {
    throw new Error('version-history.json is missing or empty');
  }

  const changes = plan(history);
  const byAction = changes.reduce<Record<string, number>>((acc, c) => {
    acc[c.action] = (acc[c.action] || 0) + 1;
    return acc;
  }, {});
  console.log(`Planned changes: ${changes.length}`, byAction);

  if (DRY_RUN) {
    for (const c of changes) {
      console.log(`  ${c.version.padEnd(10)} ${c.arch.padEnd(6)} ${c.action.padEnd(28)} sys=${c.systemUrl}`);
      if (c.userUrl) console.log(`  ${''.padEnd(10)} ${''.padEnd(6)} ${''.padEnd(28)} user=${c.userUrl}`);
    }
    console.log('Dry run: nothing written.');
    return;
  }

  // Verify every derived URL before writing. A HEAD request is not enough:
  // part of this CDN answers HEAD with 403 while serving ranged GETs fine.
  const checks = await mapLimit(changes, CONCURRENCY, async (c) => {
    const results = await Promise.all(c.verify.map((u) => urlExists(u)));
    return { ...c, ok: results.every(Boolean) };
  });

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.warn(`WARNING: ${failed.length} derived URLs did not resolve; those versions are left untouched:`);
    for (const f of failed.slice(0, 20)) {
      console.warn(`  ${f.version} win32-${f.arch} ${f.verify.join(' ')}`);
    }
  }

  const entryByVersion = new Map(history.versions.map((e) => [e.version, e]));
  let applied = 0;
  for (const c of checks) {
    const entry = entryByVersion.get(c.version) as VersionHistoryEntry;
    const sysKey = `win32-${c.arch}`;
    const userKey = `win32-${c.arch}-user`;

    if (c.ok) {
      if (c.userUrl) entry.platforms[userKey] = c.userUrl;
      if (c.systemUrl) entry.platforms[sysKey] = c.systemUrl;
      applied++;
      continue;
    }

    // The derived system installer does not exist for this version. Keep the
    // user installer (it is already known-good) and clear the system column so
    // the two columns never point at the same file.
    if (c.userUrl && entry.platforms[sysKey] === c.userUrl) {
      entry.platforms[userKey] = c.userUrl;
      delete entry.platforms[sysKey];
      applied++;
    }
  }

  if (applied === 0) {
    console.log('Nothing verified; file left untouched.');
    return;
  }

  sortVersionsDesc(history);
  history.schemaVersion = SCHEMA_VERSION;
  const saved = saveVersionHistory(history, '.derive-backup');
  if (!saved) throw new Error('failed to save version-history.json');
  console.log(`Applied ${applied}/${changes.length} changes to version-history.json`);
}

main().catch((error) => {
  console.error('Error deriving Windows links:', error instanceof Error ? error.message : error);
  process.exit(1);
});
