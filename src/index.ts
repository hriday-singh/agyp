#!/usr/bin/env node
/**
 * agyp — multi-account profile manager for the Antigravity (`agy`) CLI.
 *
 * See ARCHITECTURE.md for why this works the way it does. The short version:
 * `agy` keeps exactly one credential in the OS keyring, so a profile switch is
 * "swap that entry", and everything else in this file exists to make sure the
 * swap never loses or crosses tokens between accounts.
 */
import * as agy from './agy.js';
import { UserError, parseArgs } from './args.js';
import { guestBrowserEnv } from './browser.js';
import { describeDiff, trackCatalog } from './catalog.js';
import { fetchEmail, fetchQuota, refreshAccessToken, type Snapshot } from './google.js';
import { COMMAND_HELP, HELP } from './help.js';
import * as keyring from './keyring.js';
import { bold, cyan, dim, green, red, renderSnapshot, spinner, yellow } from './render.js';
import { cmdSpinner } from './spinner.js';
import { cmdStats, recordUsageSnapshot } from './stats.js';
import { ALL_COMMAND_NAMES, COMMAND_ALIASES, findBestMatch, formatSuggestion } from './suggest.js';
import {
  PENDING_ACCOUNT,
  VAULT_SERVICE,
  delSecret,
  fingerprint,
  getSecret,
  indexPath,
  loadIndex,
  resolve,
  saveIndex,
  setSecret,
  upsert,
  type ProfileMeta,
  type VaultIndex,
} from './vault.js';

const now = () => new Date().toISOString();

function warn(message: string): void {
  console.error(`${yellow('warning')} ${message}`);
}

function info(message: string): void {
  console.error(dim(message));
}

/**
 * Persist the live credential back into whichever profile owns it, so token
 * refreshes (and mid-session re-logins) are never lost when we switch away.
 *
 * The fingerprint is the fast path. When it does not match anything we ask
 * Google who this token belongs to rather than guessing — guessing is how one
 * account's token ends up saved under another account's profile.
 */
async function syncBack(index: VaultIndex): Promise<VaultIndex> {
  const raw = agy.readLiveRaw();
  if (!raw) return index;

  let blob: agy.AgyBlob;
  try {
    blob = agy.parseBlob(raw);
  } catch {
    warn('agy has a credential this tool cannot parse; leaving it alone');
    return index;
  }

  const print = fingerprint(blob.token.refresh_token);
  const byFingerprint = index.profiles.find((p) => p.fingerprint === print);
  if (byFingerprint) {
    setSecret(byFingerprint.email, raw);
    return upsert(index, { ...byFingerprint, lastUsed: now() });
  }

  let email: string;
  try {
    email = await fetchEmail(await refreshAccessToken(blob.token.refresh_token));
  } catch {
    warn('agy holds a credential this tool does not recognise and could not identify (offline?); left untouched');
    return index;
  }

  const known = index.profiles.find((p) => p.email === email);
  if (!known) {
    warn(`agy is signed in as ${email}, which is not a saved profile — run \`agyp adopt\` to keep it`);
    return index;
  }
  setSecret(email, raw);
  return upsert(index, { ...known, fingerprint: print, lastUsed: now() });
}

/** Undo a `login` that was interrupted before it could capture a new credential. */
function recoverPending(): void {
  const pending = getSecret(PENDING_ACCOUNT);
  if (!pending) return;
  if (agy.readLiveRaw()) return; // a login completed; the stale backup is harmless
  agy.writeLive(pending);
  delSecret(PENDING_ACCOUNT);
  warn('restored the credential saved before an interrupted `agyp login`');
}

function requireIdle(force: boolean): void {
  if (force || !agy.agyRunning()) return;
  throw new UserError(
    'agy is running. It rewrites its credential when the token refreshes, which would clobber the profile you are switching to.\n' +
      'Close it first, or pass --force if you are sure.',
  );
}

async function identify(raw: string): Promise<{ email: string; projectId?: string }> {
  const blob = agy.parseBlob(raw);
  const accessToken = await refreshAccessToken(blob.token.refresh_token);
  return { email: await fetchEmail(accessToken) };
}

function activeEmail(index: VaultIndex): string | null {
  const raw = agy.readLiveRaw();
  if (!raw) return null;
  try {
    const print = fingerprint(agy.parseBlob(raw).token.refresh_token);
    return index.profiles.find((p) => p.fingerprint === print)?.email ?? null;
  } catch {
    return null;
  }
}

function install(index: VaultIndex, profile: ProfileMeta): VaultIndex {
  const raw = getSecret(profile.email);
  if (!raw) {
    throw new UserError(
      `no stored credential for ${profile.email} — the keyring entry is gone. Run \`agyp login\` to re-add it.`,
    );
  }
  agy.writeLive(raw);
  return { ...upsert(index, { ...profile, lastUsed: now() }), active: profile.email };
}

export function validateLabel(label: string, currentEmail?: string, index?: VaultIndex): string {
  const trimmed = label.trim();
  if (/^\d+$/.test(trimmed)) {
    throw new UserError('labels cannot be numbers only');
  }
  if (index) {
    const duplicate = index.profiles.find(
      (p) => p.email !== currentEmail && p.label?.toLowerCase() === trimmed.toLowerCase(),
    );
    if (duplicate) {
      throw new UserError(`label "${trimmed}" is already used by ${duplicate.email}`);
    }
  }
  return trimmed;
}

// ---------------------------------------------------------------- commands

async function cmdAdopt(label: string | undefined): Promise<void> {
  const raw = agy.readLiveRaw();
  if (!raw) throw new UserError('agy is not signed in to anything — run `agyp login` instead');

  const stop = spinner('identifying account');
  let email: string;
  try {
    email = (await identify(raw)).email;
  } finally {
    stop();
  }
  const index = loadIndex();
  const validLabel = label ? validateLabel(label, email, index) : undefined;
  const existing = index.profiles.find((p) => p.email === email);
  setSecret(email, raw);
  const meta: ProfileMeta = {
    email,
    label: validLabel ?? existing?.label,
    fingerprint: fingerprint(agy.parseBlob(raw).token.refresh_token),
    projectId: existing?.projectId,
    addedAt: existing?.addedAt ?? now(),
    lastUsed: now(),
  };
  saveIndex({ ...upsert(index, meta), active: email });
  console.log(`${green('saved')} ${bold(email)}${validLabel ? dim(` (${validLabel})`) : ''}`);
}

/**
 * Sign-in browser. Guest Chrome by default so the OAuth page neither picks up
 * nor leaves behind a session in your normal browser; `--default-browser` opts
 * back out, and we fall back to it silently-ish if Chrome is not installed.
 */
function browserEnv(useDefault: boolean): NodeJS.ProcessEnv | undefined {
  if (useDefault) return undefined;
  const env = guestBrowserEnv();
  if (!env) {
    warn('Chrome not found — sign-in will open in your default browser');
    return undefined;
  }
  info('Sign-in opens in a Chrome guest window (isolated from your normal profile).');
  return env;
}

async function cmdLogin(
  label: string | undefined,
  force: boolean,
  defaultBrowser: boolean,
  agyArgs: string[],
): Promise<void> {
  requireIdle(force);
  const stopSync = spinner('syncing current credential');
  let index: VaultIndex;
  try {
    index = await syncBack(loadIndex());
  } finally {
    stopSync();
  }

  const previous = agy.readLiveRaw();
  if (previous) {
    setSecret(PENDING_ACCOUNT, previous); // crash-safe: recoverPending() puts it back
    agy.clearLive();
  }

  info('Starting agy with no credential. Sign in, then exit agy to finish adding the profile.');
  try {
    agy.launchAgy(agyArgs, browserEnv(defaultBrowser));
  } catch (err) {
    if (previous) agy.writeLive(previous);
    delSecret(PENDING_ACCOUNT);
    throw err;
  }

  const fresh = agy.readLiveRaw();
  if (!fresh || fresh === previous) {
    if (previous) {
      agy.writeLive(previous);
      delSecret(PENDING_ACCOUNT);
      throw new UserError('no new sign-in detected; your previous account is still active');
    }
    throw new UserError('no sign-in detected');
  }

  const stopIdentify = spinner('identifying new account');
  let email: string;
  try {
    email = (await identify(fresh)).email;
  } finally {
    stopIdentify();
  }

  const validLabel = label ? validateLabel(label, email, index) : undefined;
  const existing = index.profiles.find((p) => p.email === email);
  setSecret(email, fresh);
  index = upsert(index, {
    email,
    label: validLabel ?? existing?.label,
    fingerprint: fingerprint(agy.parseBlob(fresh).token.refresh_token),
    projectId: existing?.projectId,
    addedAt: existing?.addedAt ?? now(),
    lastUsed: now(),
  });
  saveIndex({ ...index, active: email });
  delSecret(PENDING_ACCOUNT);
  console.log(`${green(existing ? 're-authenticated' : 'added')} ${bold(email)}`);
}

function cmdList(json: boolean): void {
  const stop = spinner('loading profiles');
  let index: VaultIndex;
  let active: string | null;
  try {
    index = loadIndex();
    active = activeEmail(index);
  } finally {
    stop();
  }

  if (json) {
    console.log(JSON.stringify({ active, profiles: index.profiles }, null, 2));
    return;
  }
  if (index.profiles.length === 0) {
    console.log(dim('no profiles yet — `agyp adopt` to save the account you are signed into, `agyp login` to add one'));
    return;
  }
  index.profiles.forEach((profile, i) => {
    const marker = profile.email === active ? green('●') : dim('○');
    const label = profile.label ? cyan(` ${profile.label}`) : '';
    const used = profile.lastUsed ? dim(`  last used ${profile.lastUsed.slice(0, 10)}`) : '';
    console.log(`${marker} ${String(i + 1).padStart(2)}. ${profile.email.padEnd(30)}${label}${used}`);
  });
  if (!active) warn('agy is not signed in as any saved profile — `agyp use <target>` or `agyp adopt`');
}

async function cmdUse(target: string, force: boolean): Promise<void> {
  requireIdle(force);
  const stop = spinner('syncing credential');
  let index: VaultIndex;
  try {
    index = await syncBack(loadIndex());
  } finally {
    stop();
  }
  const profile = resolve(index, target);
  saveIndex(install(index, profile));
  console.log(`${green('active')} ${bold(profile.email)}`);
}

async function cmdRun(
  target: string | undefined,
  force: boolean,
  defaultBrowser: boolean,
  agyArgs: string[],
): Promise<never> {
  const stop = spinner('syncing credential');
  let index: VaultIndex;
  try {
    index = await syncBack(loadIndex());
  } finally {
    stop();
  }
  if (target) {
    requireIdle(force);
    const profile = resolve(index, target);
    index = install(index, profile);
    saveIndex(index);
    info(`running as ${profile.email}`);
  }

  // If agy decides it needs a fresh sign-in mid-session, that page gets the same
  // guest window as `login` — same reason.
  const code = agy.launchAgy(agyArgs, defaultBrowser ? undefined : (guestBrowserEnv() ?? undefined));
  // agy refreshes (or replaces) its token while running; capture that before exit.
  const stopBack = spinner('syncing profile updates');
  try {
    saveIndex(await syncBack(loadIndex()));
  } finally {
    stopBack();
  }
  process.exit(code);
}

async function snapshotFor(profile: ProfileMeta): Promise<{ snapshot: Snapshot; projectId?: string }> {
  const raw = getSecret(profile.email);
  if (!raw) throw new Error(`no stored credential for ${profile.email}`);
  const blob = agy.parseBlob(raw);
  return fetchQuota(blob.token.refresh_token, profile.email, profile.projectId);
}

async function cmdUsage(target: string | undefined, json: boolean): Promise<void> {
  let index = loadIndex();
  if (index.profiles.length === 0) throw new UserError('no profiles yet — run `agyp adopt` or `agyp login`');

  // No target means every profile: the usual question is "how much is left across
  // my accounts", not "how much is left on the one agy happens to hold".
  const all = !target;
  const targets = all ? index.profiles : [resolve(index, target)];

  const stop = spinner(targets.length > 1 ? `checking ${targets.length} accounts` : `checking ${targets[0]!.email}`);
  const results = await Promise.allSettled(targets.map(snapshotFor)).finally(stop);
  const snapshots: Snapshot[] = [];

  results.forEach((result, i) => {
    const profile = targets[i]!;
    if (result.status === 'rejected') {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      if (json) snapshots.push({ email: profile.email, models: [] });
      else console.log(`${bold(profile.email)}\n  ${red(reason)}`);
      return;
    }
    snapshots.push(result.value.snapshot);
    recordUsageSnapshot(result.value.snapshot);
    if (result.value.projectId && result.value.projectId !== profile.projectId) {
      index = upsert(index, { ...profile, projectId: result.value.projectId });
    }
    const changed = trackCatalog(result.value.snapshot);
    if (!json) {
      console.log(renderSnapshot(result.value.snapshot) + '\n');
      if (changed) {
        info(`  model lineup changed since the last check — \`agyp update --check\` for details\n`);
      }
    }
  });

  saveIndex(index);
  if (json) console.log(JSON.stringify(all ? snapshots : snapshots[0], null, 2));
}

/**
 * Update agy, then say what moved. The quota view adapts to renames and removals
 * on its own — this exists so the change is visible instead of silent.
 */
async function cmdUpdate(checkOnly: boolean, force: boolean): Promise<void> {
  const index = loadIndex();
  const profile = pickDefault(index);

  if (!checkOnly) {
    if (agy.agyRunning() && !force) {
      throw new UserError('agy is running — close it before updating, or pass --force');
    }
    const before = agy.agyVersion();
    console.log(`agy ${before ?? 'unknown'} — running \`agy update\``);
    const code = agy.launchAgy(['update']);
    if (code !== 0) throw new UserError(`agy update exited ${code}`);
    const after = agy.agyVersion();
    console.log(
      after && before && after !== before
        ? `${green('updated')} agy ${before} -> ${after}`
        : `agy ${after ?? 'unknown'} ${dim('(already current)')}`,
    );
  }

  const stop = spinner('checking model lineup');
  const { snapshot } = await snapshotFor(profile).finally(stop);
  const changed = trackCatalog(snapshot);
  if (!changed) {
    console.log(dim(`models: no changes for ${profile.email} (${snapshot.models.length} available)`));
    return;
  }
  console.log(bold('\nmodel changes:'));
  for (const line of describeDiff(changed)) {
    const tint = line.startsWith('+') ? green : line.startsWith('-') ? red : yellow;
    console.log('  ' + tint(line));
  }
  console.log(dim('\nnothing to change on your side — quota tracks whatever the API reports.'));
}

function pickDefault(index: VaultIndex): ProfileMeta {
  const active = activeEmail(index);
  const chosen = index.profiles.find((p) => p.email === active) ?? index.profiles[0];
  if (!chosen) throw new UserError('no profiles yet — run `agyp adopt` or `agyp login`');
  return chosen;
}

async function cmdStatus(json: boolean): Promise<void> {
  const index = loadIndex();
  const raw = agy.readLiveRaw();
  const active = activeEmail(index);

  let expiry: string | undefined;
  let unknownEmail: string | undefined;
  if (raw) {
    try {
      expiry = agy.parseBlob(raw).token.expiry;
    } catch {
      /* reported below as unparseable */
    }
    if (!active) {
      const stop = spinner('identifying the signed-in account');
      try {
        unknownEmail = (await identify(raw).finally(stop)).email;
      } catch {
        /* offline; leave undefined */
      }
    }
  }

  if (json) {
    console.log(
      JSON.stringify(
        { signedIn: Boolean(raw), activeProfile: active, unknownAccount: unknownEmail, accessTokenExpiry: expiry, profiles: index.profiles.length },
        null,
        2,
      ),
    );
    return;
  }

  if (!raw) {
    console.log(`agy: ${red('not signed in')}`);
  } else if (active) {
    console.log(`agy: ${green('signed in')} as ${bold(active)}`);
  } else {
    console.log(`agy: ${yellow('signed in')} as ${bold(unknownEmail ?? 'an unrecognised account')} ${dim('(not a saved profile — `agyp adopt`)')}`);
  }
  if (expiry) {
    const ms = new Date(expiry).getTime() - Date.now();
    console.log(dim(`  access token ${ms > 0 ? 'valid' : 'expired'}; agy refreshes it automatically`));
  }
  console.log(dim(`  ${index.profiles.length} profile(s), index at ${indexPath()}`));
}

async function cmdRemove(target: string): Promise<void> {
  const stop = spinner(`removing profile ${target}`);
  let profileEmail = '';
  try {
    const index = loadIndex();
    const profile = resolve(index, target);
    profileEmail = profile.email;
    if (activeEmail(index) === profile.email) {
      warn(`${profile.email} is the account agy is currently using; it stays signed in until you switch or log out`);
    }
    delSecret(profile.email);
    saveIndex({
      ...index,
      active: index.active === profile.email ? undefined : index.active,
      profiles: index.profiles.filter((p) => p.email !== profile.email),
    });
  } finally {
    stop();
  }
  console.log(`${green('removed')} ${profileEmail}`);
}

export function cmdLabel(target: string, newLabel: string | undefined, clear: boolean): void {
  const index = loadIndex();
  const profile = resolve(index, target);

  if (clear) {
    if (!profile.label) {
      console.log(dim(`${profile.email} has no label to clear`));
      return;
    }
    const updated = { ...profile, label: undefined };
    saveIndex(upsert(index, updated));
    console.log(`${green('cleared label')} for ${bold(profile.email)}`);
    return;
  }

  if (newLabel !== undefined && newLabel !== '') {
    const valid = validateLabel(newLabel, profile.email, index);
    const updated = { ...profile, label: valid };
    saveIndex(upsert(index, updated));
    console.log(`${green('labeled')} ${bold(profile.email)} as ${cyan(valid)}`);
    return;
  }

  if (profile.label) {
    console.log(`${bold(profile.email)} is labeled ${cyan(profile.label)}`);
  } else {
    console.log(`${bold(profile.email)} has no label`);
  }
}

function cmdDoctor(): void {
  const stop = spinner('running health checks');
  stop();
  const backend = keyring.backendAvailable();
  const line = (ok: boolean, text: string) => console.log(`${ok ? green('ok  ') : red('fail')} ${text}`);

  line(backend.ok, `keyring: ${backend.ok ? keyring.backendName() : backend.detail}`);

  const path = agy.agyPath();
  line(Boolean(path), `agy binary: ${path ?? 'not found on PATH'}`);

  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 18, `node ${process.versions.node}${major >= 18 ? '' : ' (need >= 18 for global fetch)'}`);

  try {
    const index = loadIndex();
    line(true, `vault: ${index.profiles.length} profile(s) at ${indexPath()}`);
    const orphans = index.profiles.filter((p) => !getSecret(p.email));
    if (orphans.length > 0) {
      line(false, `keyring entries missing for: ${orphans.map((o) => o.email).join(', ')} — re-run \`agyp login\``);
    }
  } catch (err) {
    line(false, err instanceof Error ? err.message : String(err));
  }

  line(!agy.agyRunning(), agy.agyRunning() ? 'agy is running — switching is blocked' : 'agy is not running');
  console.log(dim(`  secrets stored under keyring service "${VAULT_SERVICE}"`));
}

// ---------------------------------------------------------------- entrypoint

async function main(): Promise<void> {
  const { command, positional, flags, options, passthrough } = parseArgs(process.argv.slice(2));
  const primaryCommand = COMMAND_ALIASES[command] ?? command;

  if (flags.has('help') || command === 'help') {
    const topic = command === 'help' ? positional[0] : command;
    const resolvedTopic = topic ? (COMMAND_ALIASES[topic] ?? topic) : undefined;
    if (resolvedTopic && COMMAND_HELP[resolvedTopic]) {
      console.log(COMMAND_HELP[resolvedTopic]);
    } else {
      console.log(HELP);
    }
    return;
  }

  const defaultBrowser = flags.has('default-browser');
  const force = flags.has('force');
  const json = flags.has('json');
  const label = options.get('label');
  const target = positional[0];

  if (command !== 'doctor' && primaryCommand !== 'doctor') recoverPending();

  switch (primaryCommand) {
    case 'adopt':
      return cmdAdopt(label);
    case 'login':
      return cmdLogin(label, force, defaultBrowser, passthrough);
    case 'list':
      return cmdList(json);
    case 'use':
      if (!target) throw new UserError('use: which profile? `agyp list` to see them');
      return cmdUse(target, force);
    case 'run':
      await cmdRun(target, force, defaultBrowser, passthrough);
      return;
    case 'usage':
      return cmdUsage(flags.has('all') ? undefined : target, json);
    case 'update':
      return cmdUpdate(flags.has('check'), force);
    case 'status':
      return cmdStatus(json);
    case 'label':
      if (!target) throw new UserError('label: which profile? `agyp list` to see them');
      return cmdLabel(target, positional[1], flags.has('clear'));
    case 'remove':
      if (!target) throw new UserError('remove: which profile?');
      return cmdRemove(target);
    case 'doctor':
      return cmdDoctor();
    case 'stats':
      return cmdStats(json, flags.has('reset'));
    case 'spinner':
      return cmdSpinner(target);
    default: {
      const bestMatch = findBestMatch(command, ALL_COMMAND_NAMES);
      const suggestion = formatSuggestion(command, bestMatch);
      throw new UserError(`unknown command "${command}"${suggestion} — try \`agyp help\``);
    }
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${red('error')} ${message}`);
  process.exit(1);
});
