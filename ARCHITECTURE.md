# Architecture

Architectural reference and technical specifications for the agyp CLI.

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

That is the complete account identity. Everything else under `~/.gemini/` (including `antigravity-cli/settings.json`, conversation history, skills, plugins, MCP config, and trusted workspaces) is account-independent and shared.

When the OS keyring daemon is unavailable (such as headless Linux, SSH, or WSL environments without D-Bus Secret Service), `agy` falls back to storing the token in `~/.gemini/antigravity-cli/antigravity-oauth-token`. `agyp` checks the OS keyring first and falls back to this file, mirroring writes to both when switching profiles.

Two architectural principles follow:

1. **A profile switch updates the live keyring entry and token file.** No file shuffling, no `%APPDATA%` redirection, and no per-profile home directories are required.
2. **There is exactly one active slot.** Two accounts cannot be active simultaneously under one operating system user account. Parallel sessions require separate OS user accounts.

`%APPDATA%/antigravity-usage/` is unrelated; it belongs to the third-party `antigravity-usage` package and is neither read nor modified by `agyp`.

## Layout

```
src/
  index.ts     command dispatch and workflows (the single policy layer)
  help.ts      CLI help text and command descriptions
  stats.ts     aggregate usage statistics across accounts and plans
  spinner.ts   interactive loading spinner controller and demo
  suggest.ts   did-you-mean command and target suggestions
  agy.ts       live credential management, process detection, launching agy
  vault.ts     profile storage: keyring for secrets, JSON index for metadata
  keyring.ts   platform-specific storage: Credential Manager, libsecret, Keychain
  google.ts    OAuth refresh and Cloud Code quota API
  catalog.ts   tracks model lineups to detect catalog changes
  browser.ts   routes OAuth authentication to a Chrome guest window
  render.ts    terminal output rendering
  args.ts      argument parsing
```

Dependency direction is strictly one-way: `index` → components, `vault`/`agy` → `keyring`. No component below `index.ts` prints output or decides policy.

## Storage Split

Secrets are stored in the OS keyring under service `agy-profiler`, with one entry per email address.
Metadata is stored in `~/.agy-profiler/profiles.json` (mode 0600 in a 0700 directory):

```json
{
  "version": 1,
  "active": "user@example.com",
  "profiles": [
    {
      "email": "user@example.com",
      "label": "personal",
      "fingerprint": "3f9a1c...",
      "projectId": "calm-rookery-xxxxx",
      "addedAt": "2026-07-17T06:47:05.522Z",
      "lastUsed": "2026-08-10T04:55:03.555Z"
    }
  ]
}
```

Reusing the keyring for the vault (rather than encrypting a file manually) eliminates DPAPI-vs-libsecret splits, key management overhead, and plaintext token storage on disk.

`fingerprint` represents `sha256(refresh_token)` truncated to 16 hexadecimal characters. It resolves which profile is currently live from a single keyring read, without retrieving secrets for every profile.

`projectId` is cached because quota lookups otherwise require an extra `loadCodeAssist` network round trip per account.

The index file is reproducible: deleting it and running `agyp adopt` reconstructs metadata for the active profile. Secrets in the OS keyring remain authoritative.

## The Sync-Back Invariant

**Before the live credential is replaced, it must be saved back into the profile that owns it.**

OAuth tokens rotate during usage. `agy` refreshes its access token during active sessions and persists the update to the live keyring entry. Switching accounts without capturing this update would allow profile credentials to become stale, eventually invalidating refresh tokens.

`syncBack()` in `src/index.ts` executes before every profile switch and after every `agyp run`:

1. Read the live credential. If no credential exists, take no action.
2. Fingerprint the refresh token. If it matches a saved profile, update that profile's secret immediately without network calls.
3. If no fingerprint matches, query Google directly (`refresh` + `userinfo`) to identify the account before writing to storage.

Step 3 is critical. Assuming that an unrecognized token belongs to `index.active` is unsafe: if a user executes `/login` inside `agy` with a different account, that token would overwrite the previous profile and corrupt account state. When an account cannot be identified (e.g. offline status or unmanaged account), `agyp` issues a warning and leaves the credential untouched.

## Login Capture

`agy` has no standalone login subcommand; authentication occurs during interactive sessions. `agyp login` operates as follows:

1. Execute `syncBack()`, then copy the current credential to keyring entry `agy-profiler:_pending`.
2. Delete the live entry so `agy` starts unauthenticated and prompts for login.
3. Launch `agy` attached to the terminal. The user authenticates and exits.
4. Read the new credential, identify the account via `userinfo`, and persist it as a profile.
5. Delete the temporary `_pending` backup.

If the process is interrupted, `recoverPending()` (invoked at the beginning of commands) restores the previous credential. Storing the backup in the keyring guarantees resilience even if the terminal process is abruptly terminated.

## Browser Isolation During Sign-In

Sign-in initiates a Google OAuth web page. By default, this opens in the system browser, where an existing account session may already be signed in. That creates session conflicts in both directions: OAuth automatically selects the pre-existing account, and the newly added account remains signed in to the default browser.

`agy` delegates URL opening to standard platform handlers (`rundll32 url.dll,FileProtocolHandler <url>` on Windows; `xdg-open` or `open` on Unix systems), resolved via `PATH`. `agyp` intercepts this transparently:

1. `guestBrowserEnv()` generates a temporary directory containing an executable shim named after the platform handler (`rundll32.cmd` on Windows, shell scripts on Unix).
2. The shim launches `chrome --guest <url>`.
3. The temporary directory is prepended to `PATH` for the child `agy` process only.

Guest mode provides complete session isolation: a guest window shares no cookies with default profiles and leaves no residue upon exit. `--default-browser` bypasses the shim. If Chrome or Chromium is not detected, `agyp` emits a warning and falls back to default browser behavior.

On Linux, browsers are detected via `which` in order: `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`. Chromium is fully supported because `--guest` is a standard Chromium flag, and standard Linux package managers place a wrapper on `PATH`.

Two known edge cases:
- Non-standard browser install locations fall back to the default browser.
- The Windows shim executes as a batch file (`.cmd`), passing URLs through `cmd.exe` escaping. Modern Go toolchains escape `&` characters correctly; `--default-browser` serves as an escape hatch for older binaries.

## Process Gating During Execution

A running `agy` process maintains its active token in memory and rewrites the keyring entry upon refresh. Switching profiles while `agy` is running allows the active process to overwrite the newly activated profile. `agyRunning()` inspects active processes (`tasklist` on Windows, `pgrep`/`ps` on Unix) to gate `use`, `login`, and targeted `run`. The `--force` flag overrides this gate when needed.

## Quota Resolution

`agyp` queries Google Cloud Code endpoints discovered from the Antigravity CLI:

- `POST https://oauth2.googleapis.com/token`: Token refresh, using Antigravity's desktop OAuth client embedded in the `agy` binary. Can be overridden via `ANTIGRAVITY_OAUTH_CLIENT_ID` and `ANTIGRAVITY_OAUTH_CLIENT_SECRET`.
- `POST https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`: Tier and project ID resolution. Requires the `User-Agent: antigravity` header.
- `POST https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`: Model catalog and lineup metadata.
- `POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`: Authoritative pooled quota groups (e.g. "Gemini Models", "Claude and GPT models") with multi-bucket windows ("weekly" and "5h") and live `remainingFraction`.

Because quota inspection only requires a refresh token, `agyp usage` queries accounts concurrently without modifying the active keyring credential. Account querying is performed via `Promise.allSettled`: failure on one account (such as an expired refresh token) is reported individually while remaining profiles render normally.

Quota resolution and grouping rules in `parseSnapshot`:

- **Pooled groups and windows**: Google groups models into shared pools (for example, Gemini models share weekly and 5-hour limit buckets; Claude and GPT models share separate weekly and 5-hour buckets). Authoritative capacity reflects the binding minimum across active buckets.
- **Direct quota group rendering**: `agyp usage` displays quota groups directly, including weekly and 5-hour capacities and reset timers. The `--models` option adds detailed model mappings.
- **Model alias consolidation**: Multiple model IDs that share a display name and quota pool (e.g. `gemini-2.5-flash`, `gemini-2.5-flash-thinking`, and `gemini-3.1-flash-lite`) are consolidated into a single entry with the earliest reset time to avoid presenting misleading duplicate capacity.
- **Authentic fraction reporting**: When the API omits the `remainingFraction` field, `agyp` displays `n/a` rather than assuming 100%.

## Model Catalog Drift

Antigravity adds, renames, and retires models over time. The design guarantees resilience without maintenance: no model ID or display name is hardcoded in the codebase. `agyp usage` renders API responses dynamically, allowing changes to appear immediately.

`catalog.ts` provides visibility into changes:
- It maintains the last-seen `modelId -> displayName` map per account in `~/.agy-profiler/models.json`.
- It computes diffs when lineups change.
- Stable identity is established via **model ID**, not display name. Rebrands (such as updating `gemini-3.1-pro-high` display text) are tracked as renames rather than simultaneous additions and deletions.

`agyp update` executes `agy update` and displays catalog diffs. `agyp usage` evaluates catalog drift and prints a notification when changes are detected.

## Extension Guidelines

- **Adding a command**: Add a branch in `main()` and implement the corresponding handler function. Any command altering the live credential must execute `syncBack()` first and enforce `requireIdle()` unless `--force` is provided.
- **Adding platform support**: Implement platform-specific branches in `keyring.ts` (`get`, `set`, `del`, `backendName()`).
- **Usage tracking**: `agyp usage --json` provides full programmatic access for external metrics collection or scheduled logging.
- **Automation**: `list`, `status`, and `usage` all support the `--json` flag for integration into custom scripts.

## Testing Strategy

The test suite (`npm test`) validates core business logic: argument parsing, target resolution, fingerprint generation, credential blob parsing, quota aggregation, and output formatting. Keyring and network operations rely on live system verification via `agyp doctor`, `agyp adopt`, and `agyp usage`.
