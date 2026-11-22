/**
 * Generated npm lockfiles in the merge review. A raw package-lock.json diff is large (a single new dependency adds
 * hundreds of lines) and tells a reviewer little; it pushed whole pull requests over the review context limit
 * (letterflow#40). The review therefore sees a lockfile as the list of packages it adds, changes and removes, with
 * version and registry host, and a mark on every package that does not resolve from the public npm registry.
 * npm ci in CI and in the independent validation still installs the exact lockfile.
 */
export const lockfileNames = ['package-lock.json', 'npm-shrinkwrap.json'];
export const isLockfile = (path: string) => lockfileNames.includes(path.split('/').at(-1)!);
const registryHost = 'registry.npmjs.org';
const maxListed = 300;

interface Entry { version: string; host: string | null }

function packages(text: string): Map<string, Entry> | null {
  if (!text) return new Map();
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || !('packages' in value) || !value.packages || typeof value.packages !== 'object') return null;
  const result = new Map<string, Entry>();
  for (const [key, raw] of Object.entries(value.packages as Record<string, unknown>)) {
    // The root entry ("") mirrors package.json, whose diff the review sees in full.
    if (!key || !raw || typeof raw !== 'object') continue;
    const item = raw as { version?: unknown; resolved?: unknown; link?: unknown };
    let host: string | null = null;
    if (item.link === true) host = 'link';
    else if (typeof item.resolved === 'string') { try { host = new URL(item.resolved).host || item.resolved; } catch { host = item.resolved.slice(0, 100); } }
    result.set(key, { version: typeof item.version === 'string' ? item.version.slice(0, 100) : '?', host });
  }
  return result;
}

const describe = (entry: Entry) => `${entry.version}${entry.host && entry.host !== registryHost ? ` [AUSSERHALB ${registryHost}: ${entry.host}]` : ''}`;

/**
 * The review's view of a lockfile change, or null when a file is no lockfile v2/v3 (then the caller keeps the raw
 * diff). `before` is empty for an added file, `after` empty for a removed one.
 */
export function lockfileSummary(path: string, before: string, after: string, patchLines: number): string | null {
  const old = packages(before), next = packages(after);
  if (!old || !next) return null;
  const added: string[] = [], changed: string[] = [], removed: string[] = [];
  for (const [name, entry] of next) {
    const previous = old.get(name);
    if (!previous) added.push(`+ ${name} ${describe(entry)}`);
    else if (previous.version !== entry.version || previous.host !== entry.host) changed.push(`~ ${name} ${describe(previous)} -> ${describe(entry)}`);
  }
  for (const [name, entry] of old) if (!next.has(name)) removed.push(`- ${name} ${describe(entry)}`);
  const foreign = [...next.values()].filter(e => e.host && e.host !== registryHost && e.host !== 'link').length;
  const lines = [...added, ...changed, ...removed];
  return [`Generierte npm-Lockdatei ${path} (${patchLines} geänderte Zeilen, Rohdiff ausgelassen).`,
    `Pakete: ${added.length} neu, ${changed.length} geändert, ${removed.length} entfernt; ${foreign} Pakete außerhalb von ${registryHost}.`,
    ...lines.slice(0, maxListed), ...(lines.length > maxListed ? [`[… ${lines.length - maxListed} weitere Einträge nicht aufgeführt …]`] : [])].join('\n');
}
