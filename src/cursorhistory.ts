/**
 * Parsing helpers for cn.cursorhistory.com.
 *
 * The site is a Next.js App Router build: the data is not fetched by an XHR but
 * streamed inline as `self.__next_f.push([1,"..."])` chunks that the client
 * reassembles. Every download URL therefore appears in the HTML source, and
 * parsing is driven by the URLs themselves rather than by DOM structure, which
 * is what makes this robust to markup changes.
 */
import { OFFICIAL_HOSTS, hostOf } from './platforms.js';

const INDEX_URL = 'https://cn.cursorhistory.com/';
const VERSION_URL = (v: string) => `https://cn.cursorhistory.com/versions/${v}`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** Fetch a page, retrying a few times: the origin rate-limits bursts. */
async function fetchPage(url: string, attempts = 3): Promise<string> {
  let lastError = '';
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      // Back off: this origin starts refusing connections under load.
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`failed to fetch ${url}: ${lastError}`);
}

/**
 * Version -> release date, read from the index page.
 *
 * The page embeds its rows as `{"version":"X.Y.Z","date":"YYYY-MM-DD",...}`
 * objects inside the RSC payload, which is far more reliable than correlating
 * an href with a neighbouring date cell: the rendered table is grouped by
 * release channel, so a positional match lands on the wrong row.
 */
export async function fetchVersionIndex(): Promise<Map<string, string>> {
  const html = await fetchPage(INDEX_URL);
  const versions = new Map<string, string>();

  // The rendered table is server-side output: each row is
  //   <tr><td><a href="/versions/X.Y.Z">X.Y.Z</a></td><td ...>YYYY-MM-DD</td>...
  // where the href and the date cell sit close together. Correlating on the
  // href (rather than the row's position) keeps this correct even though the
  // table is grouped by release channel.
  const rowRe =
    /href="\/versions\/(\d+\.\d+\.\d+)"[^>]*>\d+\.\d+\.\d+<\/a><\/td><td[^>]*>(\d{4}-\d{2}-\d{2})<\/td>/g;
  for (const m of html.matchAll(rowRe)) {
    versions.set(m[1], m[2]);
  }

  if (versions.size === 0) {
    // Escaped-payload fallback (the raw RSC chunks).
    const escapedRe =
      /\\?"version\\?":\\?"(\d+\.\d+\.\d+)\\?",\\?"(?:releaseDate|date)\\?":\\?"(\d{4}-\d{2}-\d{2})\\?"/g;
    for (const m of html.matchAll(escapedRe)) versions.set(m[1], m[2]);
  }

  if (versions.size === 0) {
    // Degraded: at least collect the version numbers, dates come back empty.
    for (const m of html.matchAll(/\/versions\/(\d+\.\d+\.\d+)/g)) {
      if (!versions.has(m[1])) versions.set(m[1], '');
    }
  }

  return versions;
}

/** Unescape the few escapes Next.js leaves inside inline script strings. */
function cleanUrl(url: string): string {
  return url
    .replace(/\\+$/, '') // trailing backslash from a string literal
    .replace(/\\\//g, '/') // escaped slashes
    .replace(/\\u0026/g, '&');
}

/**
 * Map every official download URL on a version page to its platform key.
 *
 * URLs from any other host are returned separately with a reason, so the caller
 * can report them instead of silently ingesting a mirror.
 */
export async function fetchVersionLinks(version: string): Promise<{
  accepted: Record<string, string>;
  rejected: { url: string; reason: string }[];
}> {
  const html = await fetchPage(VERSION_URL(version), 2);

  const accepted: Record<string, string> = {};
  const rejected: { url: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(/https?:\/\/[^"'\s<>)\\]+/g)) {
    const url = cleanUrl(match[0]);
    if (seen.has(url)) continue;
    seen.add(url);

    const host = hostOf(url);
    if (!host) continue;

    const key = platformKeyOf(url);
    if (!key) continue;

    if (OFFICIAL_HOSTS.includes(host)) {
      accepted[key] = url;
    } else if (host === 'storage.googleapis.com') {
      // cursor-history-exe bucket: billing account closed, every object 403s.
      rejected.push({ url, reason: 'gcs-bucket-403' });
    } else if (host === 'downloader.cursor.sh') {
      rejected.push({ url, reason: 'dead-host' });
    } else {
      rejected.push({ url, reason: `unknown-host:${host}` });
    }
  }

  return { accepted, rejected };
}

/**
 * Classify a download URL by its path segments.
 *
 * Path-based rather than filename-based, because older builds use a different
 * shape (`/production/client/linux/x64/appimage/Cursor-0.47.2-<sha>.deb.glibc2.25-x86_64.AppImage`).
 */
export function platformKeyOf(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }

  let m = path.match(/\/darwin\/(universal|x64|arm64)\//);
  if (m) return `darwin-${m[1]}`;

  m = path.match(/\/win32\/(x64|arm64)\/user-setup\//);
  if (m) return `win32-${m[1]}-user`;

  m = path.match(/\/win32\/(x64|arm64)\/system-setup\//);
  if (m) return `win32-${m[1]}`;

  m = path.match(/\/linux\/(x64|arm64)\//);
  if (m && /\.AppImage$/.test(path)) return `linux-${m[1]}`;

  return null;
}
