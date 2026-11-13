import { promises as fs } from 'fs';
import { join } from 'path';
import type { VersionHistoryEntry } from './utils.js';
import { COLUMNS } from './platforms.js';

// Download icon, relative to README.md at the repository root.
const ICON_PATH = 'docs/assets/download.png';

const CREATE_DOWNLOAD_LINK = (url: string | undefined, archive: string | undefined): string => {
  if (!url) return '-';
  const icon = `<a href="${url}" target="_blank" rel="noopener noreferrer"><img src="${ICON_PATH}?raw=true" alt="Download" width="24" height="24"></a>`;
  // The original host is dead but an Internet Archive copy exists: keep the
  // official link visible in case it comes back, and mark the archival copy.
  const dagger = archive
    ? `<a href="${archive}" target="_blank" rel="noopener noreferrer" title="Official download no longer available; this link points to an Internet Archive copy">†</a>`
    : '';
  return icon + dagger;
};

async function updateReadme(): Promise<void> {
  // Read version history
  const historyContent = await fs.readFile(join(process.cwd(), 'version-history.json'), 'utf-8');
  const versionHistory: VersionHistoryEntry[] = JSON.parse(historyContent).versions;

  if (!Array.isArray(versionHistory) || versionHistory.length === 0) {
    throw new Error('version-history.json contains no versions');
  }

  // Read README content
  const readmePath = join(process.cwd(), 'README.md');
  // Normalize to LF immediately: with core.autocrlf=true a Windows checkout is
  // CRLF, and only replacing the marker regions would leave mixed line endings.
  let readmeContent = (await fs.readFile(readmePath, 'utf-8')).replace(/\r\n?/g, '\n');

  // Table header
  const headerCells = ['Version', 'Date', ...COLUMNS.map((c) => c.label)];
  const tableHeader = `| ${headerCells.join(' | ')} |\n|${[':---', ':---', ...COLUMNS.map(() => ':---:')].join('|')}|`;

  const downloadTable = versionHistory
    .slice(0, 20)
    .map((entry) => {
      const cells = COLUMNS.map((c) =>
        CREATE_DOWNLOAD_LINK(entry.platforms[c.key], entry.archives?.[c.key]),
      );
      return `| ${entry.version} | ${entry.date} | ${cells.join(' | ')} |`;
    })
    .join('\n');

  const newTableContent = `${tableHeader}\n${downloadTable}`;

  // Latest version details
  const latestVersion = versionHistory[0];
  const linkList = (group: 'mac' | 'win' | 'linux'): string =>
    COLUMNS.filter((c) => c.group === group)
      .map((c) => {
        const url = latestVersion.platforms[c.key];
        return url ? `[${c.label}](${url})` : '';
      })
      .filter(Boolean)
      .join(' | ');

  const latestVersionContent = `
**Version:** ${latestVersion.version} (${latestVersion.date})

*   **macOS:** ${linkList('mac')}
*   **Windows:** ${linkList('win')}
*   **Linux:** ${linkList('linux')}
`;

  // Update both sections in README
  readmeContent = readmeContent.replace(
    /<!-- LATEST_VERSION_DETAILS_START -->[\s\S]*?<!-- LATEST_VERSION_DETAILS_END -->/g,
    `<!-- LATEST_VERSION_DETAILS_START -->\n${latestVersionContent}\n<!-- LATEST_VERSION_DETAILS_END -->`,
  );
  readmeContent = readmeContent.replace(
    /<!-- TABLE_START -->[\s\S]*?<!-- TABLE_END -->/g,
    `<!-- TABLE_START -->\n${newTableContent}\n<!-- TABLE_END -->`,
  );

  const newReadmeContent = `${readmeContent.trimEnd()}\n`;
  await fs.writeFile(readmePath, newReadmeContent, 'utf8');
  console.log('README updated with new download links');
}

updateReadme().catch((error) => {
  console.error('Error updating README:', error instanceof Error ? error.message : error);
  process.exit(1);
});
