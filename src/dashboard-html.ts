import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dashboardStyles } from './dashboard-style.js';
import { DEFAULT_DASHBOARD_JOB_STATUSES } from './dashboard-data.js';

export const dashboardVersion = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

/** Resolve a full immutable source revision at server load; unavailable checkout metadata produces null. */
export function dashboardSourceRevision(): string | null {
  const override = process.env.AGENTS_RELAY_WORKFLOW_SOURCE_REF;
  if (override && /^[0-9a-f]{40}$/i.test(override)) return override;
  try {
    const repoRoot = fileURLToPath(new URL('../', import.meta.url));
    const revision = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^[0-9a-f]{40}$/i.test(revision) ? revision : null;
  } catch { return null; }
}

export const dashboardIndexHtml = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
/** Cache-bust executable app assets at the URL boundary. Public CDN cache rules may
 * override no-cache for up to four hours; a release-specific URL must never
 * reuse an older JavaScript or CSS response while /api/version is current. */
export const dashboardPageHtml = dashboardIndexHtml
  .replace('href="/dashboard.css"', `href="/dashboard.css?v=${encodeURIComponent(dashboardVersion)}"`)
  .replace('src="/vendor/markdown-it.min.js"', `src="/vendor/markdown-it.min.js?v=${encodeURIComponent(dashboardVersion)}"`)
  .replace('src="/dashboard.js"', `src="/dashboard.js?v=${encodeURIComponent(dashboardVersion)}"`);

export const dashboardClientJs = readFileSync(new URL('../dashboard/dashboard.js', import.meta.url), 'utf8');
export const dashboardMarkdownJs = readFileSync(new URL('../dashboard/vendor/markdown-it.min.js', import.meta.url), 'utf8');
export const dashboardJelFunction = readFileSync(new URL('../dashboard/jel-function.js', import.meta.url), 'utf8').trimEnd();

/** Live configuration is never handled by the service worker or stored in offline cache. */
export function dashboardConfigScript(): string {
  const config = JSON.stringify({
    version: dashboardVersion,
    sourceRef: dashboardSourceRevision(),
    statuses: DEFAULT_DASHBOARD_JOB_STATUSES,
  }).replace(/</g, '\\u003c');
  return 'window.__RELAY_DASHBOARD_CONFIG=Object.assign(' + config + ',{buildJelDiagram:' + dashboardJelFunction + '});\n'
    + "document.querySelector('.version').textContent='v'+window.__RELAY_DASHBOARD_CONFIG.version;\n";
}

/** Compatibility projection for existing test/consumer imports. Actual HTTP delivery uses static assets. */
export const dashboardHtml = dashboardIndexHtml
  .replace('<span class="version"></span>', '<span class="version">v' + dashboardVersion + '</span>')
  .replace('<link rel="stylesheet" href="/dashboard.css">', dashboardStyles)
  .replace('<script src="/dashboard-config.js" defer></script>', () => '<script>' + dashboardConfigScript() + '</script>')
  .replace('<script src="/vendor/markdown-it.min.js" defer></script>', () => '<script>\n' + dashboardMarkdownJs + '</script>')
  .replace('<script src="/dashboard.js" defer></script>', () => '<script>\n' + dashboardClientJs + '</script>');
