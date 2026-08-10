# Architecture

Notes for whoever changes this next (probably you, in six months).

## What `agy` actually stores

This is the finding the whole tool rests on, so it is worth stating precisely.

`agy` is a Go binary that keeps **exactly one** credential, in the OS keyring:

| Platform | Location |
| --- | --- |
| Windows | Credential Manager, generic credential, target `gemini:antigravity` |
| Linux | Secret Service (libsecret), attributes `service=gemini`, `username=antigravity` |
| macOS | Keychain generic password, `-s gemini -a antigravity` |

The value is UTF-8 JSON:

```json
{
  "token": {
    "access_token": "ya29...",
    "token_type": "Bearer",
    "refresh_token": "1//0g...",
    "expiry": "2026-08-10T11:15:02.55+05:30"
  },
  "auth_method": "consumer"
}
```

That is the complete account identity. Everything else under `~/.gemini/` —
`antigravity-cli/settings.json`, conversation history, skills, plugins, MCP
config, trusted workspaces — is account-independent and shared.

There is no file fallback: the binary's error strings include
`no D-Bus session bus-keyring-unavailable`, so on Linux a keyring daemon is
mandatory for `agy` itself, not just for us.

Two things follow:

1. **A profile switch is a single keyring write.** No file shuffling, no
   `%APPDATA%` redirection, no per-profile home directories.
2. **There is exactly one slot.** Two accounts cannot be live at once on one
   Windows/Linux user account. Parallel sessions would need separate OS users.

`%APPDATA%/antigravity-usage/` looks related but is not — it belongs to the
third-party `antigravity-usage` npm package. We do not read or write it.

## Layout

```
src/
  index.ts     command dispatch and the workflows (the only file with policy in it)
  agy.ts       the live credential, process detection, launching agy
  vault.ts     profile storage: keyring for secrets, JSON index for metadata
  keyring.ts   the one place that knows about Credential Manager / libsecret / Keychain
  google.ts    OAuth refresh + Cloud Code quota API
  catalog.ts   remembers the model lineup so changes can be reported
  browser.ts   sends agy's OAuth page to a Chrome guest window
  render.ts    terminal output
  args.ts      argument parsing
```

Dependency direction is one-way: `index` → everything, `vault`/`agy` → `keyring`.
Nothing below `index.ts` prints or decides policy.

## Storage split

Secrets go in the OS keyring under service `agy-profiler`, one entry per email.
Metadata goes in `~/.agy-profiler/profiles.json` (0600, in a 0700 directory):

```json
{
  "version": 1,
  "active": "you@gmail.com",
  "profiles": [
    {
      "email": "you@gmail.com",
      "label": "personal",
      "fingerprint": "3f9a1c...",
      "projectId": "calm-rookery-xxxxx",
      "addedAt": "2026-07-17T06:47:05.522Z",
      "lastUsed": "2026-08-10T04:55:03.555Z"
    }
  ]
}
```

Reusing the keyring for our own vault (rather than encrypting a file) means no
DPAPI-vs-libsecret split, no key management, and no plaintext tokens on disk.

`fingerprint` is `sha256(refresh_token)` truncated to 16 hex characters. It
answers "which profile is live?" from one keyring read, without pulling every
profile's secret out of the keyring to compare.

`projectId` is cached because quota lookups otherwise need an extra
`loadCodeAssist` round trip per account.

The index is disposable — delete it and re-run `agyp adopt`. The secrets are the
part that matters.

## The sync-back invariant

**Before the live credential is replaced, it must be saved back into the profile
that owns it.**

Tokens rotate. `agy` refreshes its access token during a session and writes the
result back to the same keyring entry. If we switched away without capturing
that, the profile would keep going stale, and eventually its refresh token could
be the invalid one.

`syncBack()` in `index.ts` runs before every switch and after every `agyp run`:

1. Read the live credential. No credential → nothing to do.
2. Fingerprint its refresh token. Matches a profile → save it there. Done, no
   network.
3. No match → **ask Google whose token this is** (refresh + `userinfo`) before
   writing anywhere.

Step 3 is the important one. The obvious shortcut — "assume it belongs to
`index.active`" — is wrong: a user who runs `/login` inside `agy` and signs in as
a different account would have that account's token saved under the previous
profile, silently corrupting both. When we cannot identify a token (offline, or
an unknown account), we warn and leave it alone. Never guess.

## Login capture

`agy` has no `login` subcommand; authentication happens inside an interactive
session. So `agyp login`:

1. Sync-back, then copy the current credential to keyring entry
   `agy-profiler:_pending`.
2. Delete the live entry, so `agy` starts unauthenticated and prompts.
3. Run `agy` attached to the terminal. The user signs in and exits.
4. Read the new credential, identify it via `userinfo`, save it as a profile.
5. Delete `_pending`.

If anything goes wrong in between, `recoverPending()` — called at the start of
every command — puts the old credential back. That is why the backup lives in
the keyring rather than in memory: a killed terminal must not lose an account.

## Browser isolation during sign-in

Step 3 above opens a Google sign-in page, and by default it would open in your
normal browser — where you are probably already signed in as someone. That is the
wrong session in both directions: the OAuth page silently picks the account
already logged in, and the account you add stays logged in there afterwards.

`agy` opens URLs the way every Go CLI does (`github.com/pkg/browser`): it shells
out to `rundll32 url.dll,FileProtocolHandler <url>` on Windows and `xdg-open` /
`open` elsewhere, each resolved through `PATH`. That means we do not need `agy`'s
cooperation and do not have to patch anything:

1. `guestBrowserEnv()` writes a temp directory containing a shim named after
   whichever of those the platform uses (`rundll32.cmd`, or executable `xdg-open`
   / `open` / `x-www-browser` / `www-browser` scripts).
2. The shim runs `chrome --guest <url>`.
3. That directory is prepended to `PATH` for the child `agy` only.

Guest mode, not a second Chrome profile: a guest window shares no cookies with
your profiles and keeps none when it closes. `--default-browser` skips the shim
entirely, and so does a machine with no Chrome installed (with a warning) —
sign-in still works, it just is not isolated.

On Linux the browser is found with `which`, in order: `google-chrome`,
`google-chrome-stable`, `chromium`, `chromium-browser`. Chromium is fine —
`--guest` is a Chromium flag, not a Google-build extra — and snap/apt/dnf
installs all put a wrapper on `PATH`. A Flatpak-only install does not, so that
case falls back to the default browser.

Two known edges. Chrome is located by well-known path (Windows/macOS) or `which`
(Linux), so an unusual install falls back to the default browser. And the Windows
shim is a batch file, which means the URL passes through `cmd` quoting; Go's
post-CVE-2024-24576 batch escaping quotes the `&` in an OAuth URL correctly, but
an `agy` built with a pre-2024 Go toolchain would truncate it — `--default-browser`
is the escape hatch if a sign-in page ever loads half a URL.

## Why switching is blocked while `agy` runs

A running `agy` holds its token in memory and rewrites the keyring entry on
refresh. Switch underneath it and the old account's token lands on top of the
profile you just activated. `agyRunning()` (`tasklist` / `pgrep`) gates `use`,
`login`, and targeted `run`. `--force` exists for when you are sure.

## Quota

Endpoints (Antigravity's own, discovered from the shipped CLI):

- `POST https://oauth2.googleapis.com/token` — refresh, using Antigravity's
  public desktop OAuth client. A desktop client "secret" is not a secret; it
  ships in every copy. Override via `ANTIGRAVITY_OAUTH_CLIENT_ID` /
  `ANTIGRAVITY_OAUTH_CLIENT_SECRET` if Google rotates it.
- `POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` — tier and
  project id. Header `User-Agent: antigravity` is required.
- `POST https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` —
  per-model `quotaInfo`.

Because this only needs a refresh token, `agyp usage` reads every account in
parallel without touching the live credential — which is why "all profiles" is the
default and a target is the narrowing case, not the other way round. Failures are
per-account (`Promise.allSettled`): one expired refresh token prints its error on
that account's line and the rest still render.

Two response quirks, both handled in `parseSnapshot`:

- **Several model ids share one display name and one quota pool** (for example
  `gemini-2.5-flash`, `gemini-2.5-flash-thinking` and `gemini-3.1-flash-lite` are
  all "Gemini 3.1 Flash Lite"). They are grouped into one row, keeping the
  earliest reset time — showing them separately reads as separate budgets.
- **`quotaInfo.remainingFraction` is often absent**, including for untouched
  pools. Absent is not "100%": internal `tab_*` models report `1` explicitly. So
  it renders as `n/a`, with the reset timer still shown. The reference
  `antigravity-usage` tool shows N/A in the same conditions.

These are undocumented internal endpoints. If quota ever returns nonsense, dump a
raw response first — the shape has changed before.

## Model catalog drift

Antigravity adds, renames and retires models on its own schedule, usually around
an `agy update`. The design decision here is that **there is nothing to adapt**:
no model id or display name is hardcoded anywhere in this tool. `usage` renders
whatever `fetchAvailableModels` returns, so a rename shows the new name, a
retired model stops appearing, and a new one appears — with no code change and no
config to maintain. Adding a per-model mapping table would create the very
maintenance burden it appears to solve.

What was actually missing was *visibility*, which is what `catalog.ts` provides.
It stores the last-seen `modelId -> displayName` map per account in
`~/.agy-profiler/models.json` and diffs against it.

Identity is the **model id**, not the display name. A rebrand
(`gemini-3.1-pro-high`: "Gemini 3.1 Pro (High)" -> "Gemini 3.5 Pro (High)") is one
rename, not a removal plus an addition. The reverse also holds: several ids can
share a display name, so display names cannot be identities.

`agyp update` runs `agy update` and then diffs. `agyp usage` diffs silently and
prints a one-line pointer when something moved — whichever command notices first
reports it, and the baseline is then current for the other. The first sighting of
an account is recorded without reporting; there is nothing to compare against.

A corrupt `models.json` is discarded rather than raised — a bad catalog file is
never a reason to fail a quota check.

## Extending it

- **A new command** — add a case in `main()` and a `cmdX` function. Anything that
  replaces the live credential must call `syncBack()` first and `requireIdle()`
  unless `--force`.
- **A new platform** — one branch each in `keyring.ts` `get`/`set`/`del`, plus
  `backendName()`. Nothing else is platform-aware except `agyRunning()`.
- **Historical usage tracking** — `usage --json` is already the machine-readable
  surface; append snapshots to a log and read them back. Do not add a background
  daemon; a scheduled `agyp usage --all --json >> log` is the whole feature.
- **Scripting** — `list`, `status`, and `usage` all take `--json`.

## Testing

`npm test` covers the pure logic: argument parsing, target resolution,
fingerprinting, credential-blob validation, quota parsing/grouping, and
rendering. Keyring and network calls are not mocked — mocking them would test
the mocks. Exercise those with `agyp doctor`, `agyp adopt`, and `agyp usage`
against a real account.

Exercised for real on Windows: `doctor`, `adopt`, `list`, `status`, `usage`, and
`update --check` (including a simulated add/rename/remove). Not yet exercised:
`login`, `use`, `run`, and `update` without `--check` — all of them write the live
credential or replace the agy binary, which needs a second account and a closed
session to test safely. The keyring read/write round trip they depend on is
proven by `adopt` + `usage`.

Verified on Windows 11 (Credential Manager) with Node 22. The Linux path is
written against `secret-tool` and the same `service`/`username` attribute pair
`agy` uses, but has not been run on a Linux box yet — check it with
`agyp doctor` first.
