/**
 * Model catalog tracking.
 *
 * Nothing in this tool hardcodes a model name — `usage` renders whatever the API
 * returns — so a rename or removal never breaks it. What it *can't* do on its own
 * is tell you the lineup changed, which matters after `agy update`.
 *
 * So we remember the last catalog we saw per account and diff against it. No
 * secrets involved, so this lives in a plain file next to the profile index.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Snapshot } from './google.js';
import { vaultDir } from './vault.js';

/** modelId -> display name, for the models a user can actually pick. */
export type Catalog = Record<string, string>;

interface CatalogFile {
  version: 1;
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

export function catalogFromSnapshot(snapshot: Snapshot): Catalog {
  const catalog: Catalog = {};
  for (const model of snapshot.models) {
    for (const id of model.modelIds) catalog[id] = model.label;
  }
  return catalog;
}

function loadFile(): CatalogFile {
  const path = catalogPath();
  if (!existsSync(path)) return { version: 1, accounts: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CatalogFile;
    return { version: 1, accounts: parsed.accounts ?? {} };
  } catch {
    // A corrupt catalog is not worth failing a quota check over; start fresh.
    return { version: 1, accounts: {} };
  }
}

export function loadCatalog(email: string): Catalog | null {
  return loadFile().accounts[email]?.models ?? null;
}

export function saveCatalog(email: string, catalog: Catalog): void {
  const file = loadFile();
  file.accounts[email] = { seenAt: new Date().toISOString(), models: catalog };
  mkdirSync(vaultDir(), { recursive: true, mode: 0o700 });
  writeFileSync(catalogPath(), JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
}

/**
 * A model id that survives with a new display name is a rename; ids appearing or
 * vanishing are additions and removals. Ids are the stable identity here —
 * display names are marketing and change on their own schedule.
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
export function trackCatalog(snapshot: Snapshot): CatalogDiff | null {
  const current = catalogFromSnapshot(snapshot);
  const previous = loadCatalog(snapshot.email);
  saveCatalog(snapshot.email, current);
  if (!previous) return null; // first sighting is not a change
  const diff = diffCatalog(previous, current);
  return isEmptyDiff(diff) ? null : diff;
}
