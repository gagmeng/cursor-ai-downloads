import * as fs from 'fs';
import * as path from 'path';

// --- Type Definitions ---

/** Where a version entry came from. Missing means 'api' (the legacy default). */
export type VersionSource = 'api' | 'cursorhistory' | 'derived';

export interface VersionHistoryEntry {
  /** "X.Y.Z" — unique across the whole history. */
  version: string;
  /** "YYYY-MM-DD" — date first seen; never overwritten for an existing entry. */
  date: string;
  /**
   * platform key -> download URL. Values are ALWAYS plain URL strings.
   * `win32-x64-user` / `win32-arm64-user` are the User Installer variants.
   */
  platforms: {
    [platform: string]: string;
  };
  /**
   * Optional: platform key -> Internet Archive copy of the same download.
   * Keys are always a subset of `platforms`. Only present for entries whose
   * original host is dead.
   */
  archives?: {
    [platform: string]: string;
  };
  /** Optional provenance marker; absent is treated as 'api'. */
  source?: VersionSource;
}

export interface VersionHistory {
  /** Absent on legacy files; treat as 1. */
  schemaVersion?: number;
  versions: VersionHistoryEntry[];
}

/** Current on-disk schema version. */
export const SCHEMA_VERSION = 2;

// --- Version Utilities ---

/** Compare two dotted numeric versions. Negative if a < b, 0 if equal. */
export function compareVersions(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** True when the entry's version is already present in the history. */
export function hasVersion(history: VersionHistory, version: string): boolean {
  return history.versions.some((e) => e.version === version);
}

/**
 * Insert an entry, or merge into an existing one without clobbering URLs that
 * are already recorded. Keeps `versions` sorted newest-first.
 * Returns 'added' | 'merged' | 'unchanged'.
 */
export function upsertVersion(
  history: VersionHistory,
  entry: VersionHistoryEntry,
  opts: { overwriteExistingUrls?: boolean } = {},
): 'added' | 'merged' | 'unchanged' {
  const existing = history.versions.find((e) => e.version === entry.version);
  if (!existing) {
    history.versions.push(entry);
    sortVersionsDesc(history);
    return 'added';
  }

  let changed = false;
  for (const [k, url] of Object.entries(entry.platforms)) {
    if (!existing.platforms[k] || opts.overwriteExistingUrls) {
      if (existing.platforms[k] !== url) {
        existing.platforms[k] = url;
        changed = true;
      }
    }
  }
  for (const [k, url] of Object.entries(entry.archives ?? {})) {
    if (!existing.archives?.[k] || opts.overwriteExistingUrls) {
      if (existing.archives?.[k] !== url) {
        existing.archives = existing.archives ?? {};
        existing.archives[k] = url;
        changed = true;
      }
    }
  }
  if (changed) sortVersionsDesc(history);
  return changed ? 'merged' : 'unchanged';
}

/** Sort entries newest-first, in place. */
export function sortVersionsDesc(history: VersionHistory): void {
  history.versions.sort((a, b) => compareVersions(b.version, a.version));
}

// --- Filesystem Utilities ---

/**
 * Reads version history from JSON file.
 * Returns an empty history object if the file doesn't exist or is invalid.
 */
export function readVersionHistory(): VersionHistory {
  const historyPath = path.join(process.cwd(), 'version-history.json');
  if (fs.existsSync(historyPath)) {
    try {
      const jsonData = fs.readFileSync(historyPath, 'utf8');
      // Basic validation
      const parsedData = JSON.parse(jsonData);
      if (parsedData && Array.isArray(parsedData.versions)) {
        return parsedData as VersionHistory;
      } else {
        console.error('Invalid format in version-history.json');
        return { versions: [] };
      }
    } catch (error) {
      console.error('Error reading or parsing version-history.json:', error instanceof Error ? error.message : 'Unknown error');
      return { versions: [] };
    }
  } else {
    console.warn('version-history.json not found.');
    return { versions: [] };
  }
}

/**
 * Saves version history to JSON file with backup.
 * Returns true on success, false on failure.
 */
export function saveVersionHistory(history: VersionHistory, backupSuffix: string = '.backup'): boolean {
  if (!history || !Array.isArray(history.versions)) {
    console.error('Invalid version history object provided to saveVersionHistory');
    return false;
  }

  const historyPath = path.join(process.cwd(), 'version-history.json');
  const backupPath = `${historyPath}${backupSuffix}`;

  // Create a backup before saving
  try {
    if (fs.existsSync(historyPath)) {
      fs.copyFileSync(historyPath, backupPath);
      // console.log(`Created backup at ${backupPath}`); // Commented out for GH Action
    }
  } catch (error) {
     console.error(`Failed to create backup at ${backupPath}:`, error instanceof Error ? error.message : 'Unknown error');
     // Optionally, decide if you want to proceed without backup
     // For now, we'll stop if backup fails to be safe.
     return false;
  }

  try {
    // Pretty print JSON with 2 spaces
    const jsonData = JSON.stringify(history, null, 2);
    // Write to a temporary file first, then rename
    const tempPath = `${historyPath}.tmp`;
    fs.writeFileSync(tempPath, jsonData, 'utf8');
    fs.renameSync(tempPath, historyPath);
    // console.log(`Version history saved successfully to ${historyPath}`); // Commented out for GH Action
    return true;
  } catch (error) {
    console.error('Error saving version history:', error instanceof Error ? error.message : 'Unknown error');
    // Attempt to restore from backup if save failed
    try {
        if (fs.existsSync(backupPath)) {
            fs.renameSync(backupPath, historyPath);
            // console.log(`Restored ${historyPath} from backup.`); // Commented out for GH Action
        }
    } catch (restoreError) {
        console.error(`Failed to restore from backup ${backupPath}:`, restoreError instanceof Error ? restoreError.message : 'Unknown error');
    }
    return false;
  }
}

/**
 * Reads content from a file.
 * Returns null if the file doesn't exist or reading fails.
 */
export function readFileContent(filePath: string): string | null {
    const absolutePath = path.join(process.cwd(), filePath);
    if (!fs.existsSync(absolutePath)) {
        console.error(`File not found: ${absolutePath}`);
        return null;
    }
    try {
        return fs.readFileSync(absolutePath, 'utf8');
    } catch (error) {
        console.error(`Error reading file ${absolutePath}:`, error instanceof Error ? error.message : 'Unknown error');
        return null;
    }
}

/**
 * Writes content to a file with backup.
 * Returns true on success, false on failure.
 */
export function writeFileContent(filePath: string, content: string, backupSuffix: string = '.backup'): boolean {
    const absolutePath = path.join(process.cwd(), filePath);
    const backupPath = `${absolutePath}${backupSuffix}`;

    // Create backup
    try {
        if (fs.existsSync(absolutePath)) {
            fs.copyFileSync(absolutePath, backupPath);
            // console.log(`Created backup at ${backupPath}`); // Commented out for GH Action
        }
    } catch (error) {
        console.error(`Failed to create backup at ${backupPath}:`, error instanceof Error ? error.message : 'Unknown error');
        return false; // Stop if backup fails
    }

    try {
        // Write to temp file then rename
        const tempPath = `${absolutePath}.tmp`;
        fs.writeFileSync(tempPath, content, 'utf8');
        fs.renameSync(tempPath, absolutePath);
        // console.log(`Content successfully written to ${absolutePath}`); // Commented out for GH Action
        return true;
    } catch (error) {
        console.error(`Error writing file ${absolutePath}:`, error instanceof Error ? error.message : 'Unknown error');
        // Attempt to restore from backup
        try {
            if (fs.existsSync(backupPath)) {
                fs.renameSync(backupPath, absolutePath);
                // console.log(`Restored ${absolutePath} from backup.`); // Commented out for GH Action
            }
        } catch (restoreError) {
            console.error(`Failed to restore from backup ${backupPath}:`, restoreError instanceof Error ? restoreError.message : 'Unknown error');
        }
        return false;
    }
}

// --- Date Utilities ---

/**
 * Format date as YYYY-MM-DD
 */
export function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// --- Other Utilities ---

/**
 * Extract version from URL or filename.
 *
 * Fallback only: current Cursor download URLs carry no version in the file name
 * (`.../production/<sha>/darwin/arm64/Cursor-darwin-arm64.dmg`), so the API's
 * own `version` field is the primary source. The legacy naming this once
 * matched (`CursorUserSetup-x64-1.2.3.exe`) is no longer produced, so its
 * pattern was dropped rather than left to silently fail.
 */
export function extractVersion(url: string): string {
  const versionMatch = url.match(/([0-9]+\.[0-9]+\.[0-9]+)/);
  return versionMatch ? versionMatch[0] : 'Unknown';
}

// --- Network Utilities ---

/**
 * Check that a URL is downloadable, using a ranged GET.
 *
 * HEAD is deliberately avoided: several CDNs answer it with 403 even though the
 * file is public. Only the response headers are read; the body is cancelled.
 */
export async function urlExists(url: string, timeoutMs = 15000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-1023', 'User-Agent': 'cursor-downloads-tracker' },
      signal: controller.signal,
      redirect: 'follow',
    });
    await res.body?.cancel();
    return res.status === 200 || res.status === 206;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run `fn` over `items` with at most `limit` promises in flight.
 * Results keep the input order.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}