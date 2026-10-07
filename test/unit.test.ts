import { readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agyCommandLines, finalFrame, isAgyBlob, isBgUpdater, parseBlob } from '../src/agy.js';
import { chromePath, guestBrowserEnv } from '../src/browser.js';
import { UserError, parseArgs } from '../src/args.js';
import { catalogFromSnapshot, describeDiff, diffCatalog, isEmptyDiff } from '../src/catalog.js';
import { COMMAND_HELP, HELP } from '../src/help.js';
import { validateLabel } from '../src/index.js';
import { decodeGoKeyring, winTarget } from '../src/keyring.js';
import { resetLabel, spinner } from '../src/render.js';
import { cmdSpinner, getRandomSpinnerText, SPINNER_TEXTS } from '../src/spinner.js';
import { COMMAND_ALIASES, findBestMatch, levenshtein } from '../src/suggest.js';
import { fingerprint, resolve, upsert, type VaultIndex } from '../src/vault.js';

describe('parseArgs', () => {
  it('splits command, positional, flags and passthrough', () => {
    const parsed = parseArgs(['run', 'work', '--force', '--', '--verbose', 'debug']);
    expect(parsed.command).toBe('run');
    expect(parsed.positional).toEqual(['work']);
    expect(parsed.flags.has('force')).toBe(true);
    expect(parsed.passthrough).toEqual(['--verbose', 'debug']);
  });

  it('reads --label as a value option, not a flag', () => {
    const parsed = parseArgs(['login', '--label', 'personal']);
    expect(parsed.options.get('label')).toBe('personal');
    expect(parsed.flags.has('label')).toBe(false);
    expect(parsed.positional).toEqual([]);
  });

  it('parses --option=value syntax', () => {
    const parsed = parseArgs(['login', '--label=work']);
    expect(parsed.options.get('label')).toBe('work');
    expect(parsed.flags.has('label')).toBe(false);
    expect(parsed.positional).toEqual([]);
  });

  it('parses label and rename positional commands', () => {
    const p1 = parseArgs(['label', '1', 'work']);
    expect(p1.command).toBe('label');
    expect(p1.positional).toEqual(['1', 'work']);

    const p2 = parseArgs(['rename', 'personal', 'work']);
    expect(p2.command).toBe('rename');
    expect(p2.positional).toEqual(['personal', 'work']);

    const p3 = parseArgs(['label', 'personal', '--clear']);
    expect(p3.command).toBe('label');
    expect(p3.positional).toEqual(['personal']);
    expect(p3.flags.has('clear')).toBe(true);
  });

  it('rejects --label with no value', () => {
    expect(() => parseArgs(['login', '--label'])).toThrow(UserError);
    expect(() => parseArgs(['login', '--label='])).toThrow(UserError);
  });

  it('defaults to help', () => {
    expect(parseArgs([]).command).toBe('help');
    expect(parseArgs(['-h']).flags.has('help')).toBe(true);
  });

  it('normalizes commands case-insensitively', () => {
    expect(parseArgs(['STATUS']).command).toBe('status');
    expect(parseArgs(['LiSt']).command).toBe('list');
  });

  it('supports positional label after login (e.g. agyp login pa)', () => {
    const parsed = parseArgs(['login', 'pa']);
    expect(parsed.command).toBe('login');
    expect(parsed.options.get('label')).toBe('pa');
    expect(parsed.positional).toEqual([]);
  });

  it('supports positional label before save/adopt/login (e.g. agyp pa login)', () => {
    const p1 = parseArgs(['pa', 'login']);
    expect(p1.command).toBe('login');
    expect(p1.options.get('label')).toBe('pa');

    const p2 = parseArgs(['pa', 'adopt']);
    expect(p2.command).toBe('adopt');
    expect(p2.options.get('label')).toBe('pa');

    const p3 = parseArgs(['pa', 'save']);
    expect(p3.command).toBe('save');
    expect(p3.options.get('label')).toBe('pa');
  });

  it('prioritizes explicit --label over positional label', () => {
    const p1 = parseArgs(['login', '--label', 'explicit', 'pa']);
    expect(p1.options.get('label')).toBe('explicit');

    const p2 = parseArgs(['pa', 'login', '--label', 'explicit']);
    expect(p2.options.get('label')).toBe('explicit');
  });

  it('does not normalize when the first command is already a known command', () => {
    const p1 = parseArgs(['help', 'login']);
    expect(p1.command).toBe('help');
    expect(p1.positional).toEqual(['login']);

    const p2 = parseArgs(['use', 'pa']);
    expect(p2.command).toBe('use');
    expect(p2.positional).toEqual(['pa']);
    expect(p2.options.get('label')).toBeUndefined();
  });
});

const index: VaultIndex = {
  version: 1,
  profiles: [
    { email: 'alice@gmail.com', label: 'personal', fingerprint: 'aaaa', addedAt: '2026-01-01T00:00:00Z' },
    { email: 'alice.work@gmail.com', fingerprint: 'bbbb', addedAt: '2026-01-01T00:00:00Z' },
    { email: 'bob@gmail.com', fingerprint: 'cccc', addedAt: '2026-01-01T00:00:00Z' },
  ],
};

describe('validateLabel', () => {
  it('accepts valid labels and trims whitespace', () => {
    expect(validateLabel('  hello  ')).toBe('hello');
    expect(validateLabel('work-1')).toBe('work-1');
  });

  it('rejects labels that are numbers only', () => {
    expect(() => validateLabel('123')).toThrow(/numbers only/);
    expect(() => validateLabel('1')).toThrow(/numbers only/);
  });

  it('rejects duplicate labels', () => {
    expect(() => validateLabel('personal', 'bob@gmail.com', index)).toThrow(/already used/);
    expect(validateLabel('personal', 'alice@gmail.com', index)).toBe('personal');
  });
});

describe('resolve', () => {
  it('matches exact email, 1-based index and label', () => {
    expect(resolve(index, 'bob@gmail.com').email).toBe('bob@gmail.com');
    expect(resolve(index, '1').email).toBe('alice@gmail.com');
    expect(resolve(index, 'personal').email).toBe('alice@gmail.com');
  });

  it('matches an unambiguous prefix but refuses an ambiguous one', () => {
    expect(resolve(index, 'bob').email).toBe('bob@gmail.com');
    expect(() => resolve(index, 'alice')).toThrow(/be more specific/);
  });

  it('reports missing profiles and out-of-range indexes', () => {
    expect(() => resolve(index, 'nobody')).toThrow(/no profile matching/);
    expect(() => resolve(index, '9')).toThrow(/no profile #9/);
  });
});

describe('upsert', () => {
  it('replaces by email and keeps the list sorted', () => {
    const next = upsert(index, { ...index.profiles[0]!, label: 'renamed' });
    expect(next.profiles).toHaveLength(3);
    expect(next.profiles.find((p) => p.email === 'alice@gmail.com')?.label).toBe('renamed');
    expect(next.profiles.map((p) => p.email)).toEqual([...next.profiles.map((p) => p.email)].sort());
  });
});

describe('fingerprint', () => {
  it('is stable and distinguishes tokens without exposing them', () => {
    const token = '1//0gjE4Raq_secret';
    expect(fingerprint(token)).toBe(fingerprint(token));
    expect(fingerprint(token)).not.toBe(fingerprint(token + 'x'));
    expect(fingerprint(token)).not.toContain('secret');
    expect(fingerprint(token)).toHaveLength(16);
  });
});

describe('agy credential blob', () => {
  const valid = JSON.stringify({
    token: { access_token: 'ya29.x', token_type: 'Bearer', refresh_token: '1//abc', expiry: '2026-08-10T11:15:02Z' },
    auth_method: 'consumer',
  });

  it('accepts the shape agy writes', () => {
    expect(parseBlob(valid).token.refresh_token).toBe('1//abc');
    expect(isAgyBlob(JSON.parse(valid))).toBe(true);
  });

  it('refuses anything without a refresh token, so we never install a dud', () => {
    expect(() => parseBlob('not json')).toThrow(/not JSON/);
    expect(() => parseBlob('{"token":{"access_token":"x"}}')).toThrow(/refresh_token/);
    expect(isAgyBlob({ token: null })).toBe(false);
  });
});

describe('model catalog', () => {
  it('flattens a snapshot into modelId -> label', () => {
    const catalog = catalogFromSnapshot({
      email: 'a@b.com',
      models: [
        { label: 'Flash Lite', modelIds: ['gemini-2.5-flash', 'gemini-3.1-flash-lite'], isExhausted: false },
        { label: 'Claude Opus', modelIds: ['claude-opus-4-6-thinking'], isExhausted: false },
      ],
    });
    expect(catalog).toEqual({
      'gemini-2.5-flash': 'Flash Lite',
      'gemini-3.1-flash-lite': 'Flash Lite',
      'claude-opus-4-6-thinking': 'Claude Opus',
    });
  });

  it('separates additions, removals and renames', () => {
    const diff = diffCatalog(
      { keep: 'Same', gone: 'Old Model', moved: 'Gemini 3.1 Pro' },
      { keep: 'Same', moved: 'Gemini 3.5 Pro', fresh: 'Gemini 4 Flash' },
    );
    expect(diff.added).toEqual([{ modelId: 'fresh', label: 'Gemini 4 Flash' }]);
    expect(diff.removed).toEqual([{ modelId: 'gone', label: 'Old Model' }]);
    expect(diff.renamed).toEqual([{ modelId: 'moved', from: 'Gemini 3.1 Pro', to: 'Gemini 3.5 Pro' }]);
    expect(isEmptyDiff(diff)).toBe(false);
    expect(describeDiff(diff)).toHaveLength(3);
  });

  it('reports no change when the lineup is identical', () => {
    const same = { a: 'A', b: 'B' };
    expect(isEmptyDiff(diffCatalog(same, { ...same }))).toBe(true);
  });
});

describe('keyring target naming', () => {
  it('matches the scheme agy uses, so we read its real entry', () => {
    expect(winTarget('gemini', 'antigravity')).toBe('gemini:antigravity');
  });
});

describe('guest browser shim', () => {
  it('puts a shim dir first on PATH and points it at Chrome in guest mode', () => {
    if (!chromePath()) return; // no Chrome on this machine: agyp falls back to the default browser
    const env = guestBrowserEnv({ PATH: '/existing' })!;
    const dir = env['PATH']!.split(delimiter)[0]!;
    const shim = process.platform === 'win32' ? 'rundll32.cmd' : 'xdg-open';
    const script = readFileSync(join(dir, shim), 'utf8');
    expect(script).toContain('--guest');
    expect(env['PATH']!.endsWith('/existing')).toBe(true);
    // cmd splits `url.dll,FileProtocolHandler` into two arguments, so a fixed
    // %2 opens "FileProtocolHandler" instead of the OAuth URL.
    if (process.platform === 'win32') {
      expect(script).not.toContain('%~2');
      expect(script).toContain('tokens=1,*');
    }
  }, 30000);
});

describe('help text', () => {
  it('includes label command in general and command help', () => {
    expect(HELP).toContain('label <target> [name]');
    expect(COMMAND_HELP.label).toContain('agyp label');
    expect(COMMAND_HELP.label).toContain('agyp rename');
    expect(COMMAND_HELP.stats).toContain('agyp stats');
  });
});

describe('command aliases', () => {
  it('maps common aliases to primary commands', () => {
    expect(COMMAND_ALIASES.save).toBe('adopt');
    expect(COMMAND_ALIASES.add).toBe('login');
    expect(COMMAND_ALIASES.show).toBe('list');
    expect(COMMAND_ALIASES.select).toBe('use');
    expect(COMMAND_ALIASES.exec).toBe('run');
    expect(COMMAND_ALIASES.credits).toBe('usage');
    expect(COMMAND_ALIASES.upgrade).toBe('update');
    expect(COMMAND_ALIASES.info).toBe('status');
    expect(COMMAND_ALIASES.tag).toBe('label');
    expect(COMMAND_ALIASES.delete).toBe('remove');
    expect(COMMAND_ALIASES.check).toBe('doctor');
    expect(COMMAND_ALIASES.metrics).toBe('stats');
  });
});

describe('Did You Mean suggestions', () => {
  it('calculates Levenshtein edit distance', () => {
    expect(levenshtein('status', 'statuss')).toBe(1);
    expect(levenshtein('login', 'logn')).toBe(1);
    expect(levenshtein('cat', 'dog')).toBe(3);
  });

  it('finds best matching candidate', () => {
    expect(findBestMatch('statuss', ['status', 'list', 'run'])).toBe('status');
    expect(findBestMatch('personl', ['personal', 'work'])).toBe('personal');
    expect(findBestMatch('xyz123', ['status', 'list'])).toBeNull();
  });

  it('suggests closest match when profile target is not found in resolve()', () => {
    expect(() => resolve(index, 'personl')).toThrow(/did you mean "personal"\?/);
    expect(() => resolve(index, 'bo')).toBeDefined(); // matches bob@gmail.com by prefix!
  });
});

describe('spinner command and controller', () => {
  it('includes standard status messages in SPINNER_TEXTS', () => {
    expect(SPINNER_TEXTS).toContain('identifying account');
    expect(SPINNER_TEXTS).toContain('syncing current credential');
    expect(SPINNER_TEXTS).toContain('identifying new account');
    expect(SPINNER_TEXTS).toContain('loading profiles');
    expect(SPINNER_TEXTS).toContain('syncing credential');
    expect(SPINNER_TEXTS).toContain('syncing profile updates');
    expect(SPINNER_TEXTS).toContain('checking model lineup');
    expect(SPINNER_TEXTS).toContain('running health checks');
    expect(SPINNER_TEXTS.length).toBeGreaterThanOrEqual(8);
  });

  it('getRandomSpinnerText selects a valid text and excludes current if possible', () => {
    const text = getRandomSpinnerText();
    expect(SPINNER_TEXTS).toContain(text);

    const nextText = getRandomSpinnerText('identifying account');
    expect(SPINNER_TEXTS).toContain(nextText);
    expect(nextText).not.toBe('identifying account');
  });

  it('spinner creates controller with update method and stops cleanly', () => {
    const stop = spinner('initial test');
    expect(typeof stop).toBe('function');
    expect(typeof stop.update).toBe('function');
    expect(() => stop.update('updated test')).not.toThrow();
    expect(() => stop()).not.toThrow();
  });

  it('cmdSpinner validates input duration', async () => {
    await expect(cmdSpinner('-5')).rejects.toThrow(UserError);
    await expect(cmdSpinner('0')).rejects.toThrow(UserError);
    await expect(cmdSpinner('abc')).rejects.toThrow(UserError);
  });

  it('cmdSpinner executes with short duration', async () => {
    await expect(cmdSpinner('0.05')).resolves.toBeUndefined();
  });

  it('maps spin and loading aliases to spinner', () => {
    expect(COMMAND_ALIASES['spin']).toBe('spinner');
    expect(COMMAND_ALIASES['loading']).toBe('spinner');
  });

  it('documents spinner in help', () => {
    expect(HELP).toContain('spinner [seconds]');
    expect(COMMAND_HELP['spinner']).toBeDefined();
    expect(COMMAND_HELP['spinner']).toContain('agyp spinner');
  });
});

describe('finalFrame', () => {
  it('keeps only what agy left after its last redraw', () => {
    expect(finalFrame('\u25d0 checking\r\u25d3 checking\rfound new version 1.2.0')).toBe(
      'found new version 1.2.0',
    );
    expect(finalFrame('already up to date')).toBe('already up to date');
    expect(finalFrame('\r   \r  ')).toBe('');
  });
});

describe('resetLabel', () => {
  it('hides the rolling countdown on a full bucket', () => {
    expect(resetLabel(1, 5 * 3600_000)).toBe('');
    expect(resetLabel(0.72, 3600_000)).toContain('resets in');
    expect(resetLabel(0.5, undefined)).toBe('');
  });
});

describe('agy process detection', () => {
  it('treats the background updater as not running', () => {
    expect(isBgUpdater('C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.EXE --bg-updater --app_data_dir=antigravity-cli')).toBe(true);
    expect(isBgUpdater('"C:\\agy\\agy.EXE" --continue')).toBe(false);
  });

  it('picks only agy executables out of ps output', () => {
    const ps = ['/usr/bin/bash', '/home/me/.local/bin/agy --bg-updater', 'agy', 'node agyp.js', 'vim agy.ts', ''].join('\n');
    expect(agyCommandLines(ps)).toEqual(['/home/me/.local/bin/agy --bg-updater', 'agy']);
  });
});

describe('decodeGoKeyring', () => {
  it('decodes go-keyring macOS values and passes plain ones through', () => {
    const blob = '{"token":{"refresh_token":"1//x"}}';
    expect(decodeGoKeyring('go-keyring-encoded:' + Buffer.from(blob).toString('hex'))).toBe(blob);
    expect(decodeGoKeyring('go-keyring-base64:' + Buffer.from(blob).toString('base64'))).toBe(blob);
    expect(decodeGoKeyring(blob)).toBe(blob);
  });
});
