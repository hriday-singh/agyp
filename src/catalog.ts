/**
 * Model catalog tracking.
 *
 * Nothing in this tool hardcodes a model name; `usage` renders whatever the API
 * returns, so a rename or removal never breaks it. What it cannot do on its own
 * is tell you the lineup changed, which matters after `agy update`.
 *
 * The lineup comes from `agy models`, not the Cloud Code API: agy ships its
 * picker catalog inside the binary (effort variants, new families), so the API
 * picker stays the same across agy updates while the real lineup moves.
 *
 * We remember the last catalog we saw per account and diff against it. No
 * secrets involved, so this lives in a plain file next to the profile index.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vaultDir } from './vault.js';

/** modelId -> display name, for the models a user can actually pick. */
export type Catalog = Record<string, string>;

/** Bumped when the catalog source changes, so stale baselines are dropped instead of diffed. */
const CATALOG_VERSION = 2;

interface CatalogFile {
  version: typeof CATALOG_VERSION;
  accounts: Record<string, { seenAt: string; models: Catalog }>;
}

export interface CatalogDiff {
  added: { modelId: string; label: string }[];
  removed: { modelId: string; label: string }[];
  renamed: { modelId: string; from: string; to: string }[];
}

export function catalogPath(): string {
  return join(vaultDir(), 'models.json');
}

/** `agy models` prints one `<modelId>\t<display name>` per line; anything else is chatter. */
export function parseAgyModels(output: string): Catalog {
  const catalog: Catalog = {};
  for (const raw of output.split(/\r?\n/)) {
    const line = (raw.split('\r').pop() ?? '').trim();
    const m = /^([a-z0-9][\w.@-]*)\t+(.+)$/i.exec(line);
    if (m) catalog[m[1]!] = m[2]!.trim();
  }
  return catalog;
}

function loadFile(): CatalogFile {
  const path = catalogPath();
  const empty: CatalogFile = { version: CATALOG_VERSION, accounts: {} };
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CatalogFile>;
    // Older versions came from a different source; diffing them would be noise.
    if (parsed.version !== CATALOG_VERSION) return empty;
    return { version: CATALOG_VERSION, accounts: parsed.accounts ?? {} };
  } catch {
    // A corrupt catalog is not worth failing a quota check over; start fresh.
    return empty;
  }
}

export function loadCatalog(email: string): Catalog | null {
  return loadFile().accounts[email]?.models ?? null;
}

export function saveCatalog(email: string, catalog: Catalog): void {
  const file = loadFile();
  file.accounts[email] = { seenAt: new Date().toISOString(), models: catalog };
  try {
    mkdirSync(vaultDir(), { recursive: true, mode: 0o700 });
    writeFileSync(catalogPath(), JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  } catch {
    // non-fatal
  }
}

export function removeCatalog(email: string): void {
  const file = loadFile();
  if (file.accounts[email]) {
    delete file.accounts[email];
    try {
      mkdirSync(vaultDir(), { recursive: true, mode: 0o700 });
      writeFileSync(catalogPath(), JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
    } catch {
      // non-fatal
    }
  }
}

/**
 * A model id that survives with a new display name is a rename; ids appearing or
 * vanishing are additions and removals. Model IDs serve as the stable identity here;
 * display names can change on their own schedule.
 */
export function diffCatalog(before: Catalog, after: Catalog): CatalogDiff {
  const diff: CatalogDiff = { added: [], removed: [], renamed: [] };

  for (const [modelId, label] of Object.entries(after)) {
    const previous = before[modelId];
    if (previous === undefined) diff.added.push({ modelId, label });
    else if (previous !== label) diff.renamed.push({ modelId, from: previous, to: label });
  }
  for (const [modelId, label] of Object.entries(before)) {
    if (after[modelId] === undefined) diff.removed.push({ modelId, label });
  }

  return diff;
}

export function isEmptyDiff(diff: CatalogDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.renamed.length === 0;
}

export function describeDiff(diff: CatalogDiff): string[] {
  return [
    ...diff.added.map((m) => `+ new    ${m.label} (${m.modelId})`),
    ...diff.renamed.map((m) => `~ renamed ${m.from} -> ${m.to} (${m.modelId})`),
    ...diff.removed.map((m) => `- gone   ${m.label} (${m.modelId})`),
  ];
}

/** Record the current catalog and report what moved since last time. */
export function trackCatalog(email: string, current: Catalog): CatalogDiff | null {
  const previous = loadCatalog(email);
  saveCatalog(email, current);
  if (!previous) return null; // first sighting is not a change
  const diff = diffCatalog(previous, current);
  return isEmptyDiff(diff) ? null : diff;
}
