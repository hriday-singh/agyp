# agyp: Multi-Account Profile Manager for the Antigravity CLI

`agyp` provides multi-account profile management and quota inspection for the Google Antigravity (`agy`) command-line interface. While `agy` maintains a single active Google authentication credential at a time, `agyp` securely manages multiple accounts, switches between them instantly, and inspects model quota across all accounts concurrently without modifying your active session.

Supported platforms: Windows and Linux (macOS best-effort). Zero external runtime dependencies.

```
$ agyp list
●  1. alex.personal@gmail.com          personal  last used 2026-08-10
○  2. alex.work@gmail.com              work      last used 2026-08-09

$ agyp usage
alex.personal@gmail.com (Google AI Pro)
  Gemini Models
    Weekly Limit Remaining           ████████████████░░░░   79%  resets in 1d 11h
    Five Hour Limit Remaining        ████████████████████  100%
    Models within this group: Gemini Flash, Gemini Pro
  Claude and GPT models
    Weekly Limit Remaining           ████████████████████  100%
    Five Hour Limit Remaining        ████████████████████  100%
    Models within this group: Claude Opus, Claude Sonnet, GPT-OSS
...
(pass --models to view individual models mapped to pools)
```

## Key Capabilities

- **Instant Switching**: Switch active credentials in the OS keyring without modifying local configuration files or directories.
- **Concurrent Quota Inspection**: Query pooled model quotas and prompt credits across all saved accounts simultaneously without switching.
- **Isolated Authentication**: Launch new logins in dedicated Chrome guest windows to prevent session collision with your system browser.
- **Credential Integrity**: Automatically synchronize rotated tokens back to profile storage on session exit.
- **Process Safety**: Prevent accidental credential collisions while `agy` is running.
- **Model Drift Detection**: Track dynamic model catalog changes and notify you when models are added, renamed, or retired.

## Installation

### Prerequisites

- Node.js 18 or higher
- The `agy` CLI installed and available on your system `PATH`

### Build and Install

```bash
git clone https://github.com/hriday-singh/agyp.git
cd agyp
npm install
npm run build
npm link
```

### Linux Keyring Configuration

On Linux with a graphical session, `agyp` integrates with standard Secret Service daemons (`gnome-keyring` or `kwallet`):

```bash
# Debian / Ubuntu
sudo apt install libsecret-tools

# Fedora / RHEL
sudo dnf install libsecret
```

On headless Linux environments, containers, or SSH sessions without D-Bus Secret Service, `agyp` falls back to secure file-based storage with `0600` permissions in `~/.agy-profiler/secrets/` and `~/.gemini/antigravity-cli/antigravity-oauth-token`. Run `agyp doctor` to check the active storage backend.

## Quick Start

```bash
# Save the account currently signed in to agy
agyp adopt --label personal

# Add a second account (authenticates through an isolated guest window)
agyp login --label work

# View all saved profiles and inspect the active account
agyp list

# Switch the default active profile
agyp use work

# Switch to a profile and launch agy immediately
agyp run personal

# Check model quota across all accounts
agyp usage

# Check model quota for a single account
agyp usage work
```

Run `agyp adopt` initially to capture your existing session without having to sign in again.

## Command Workflows: `use` vs `run`

`agyp help use` displays workflow details at any time.

- **`agyp use <target>`**: Updates the active credential in the OS keyring and exits immediately. The `agy` CLI is not launched. Subsequent `agy` executions (from any terminal or editor) use this active profile until switched again.
- **`agyp run [target] [-- args]`**: Switches to the specified profile (if provided) and immediately starts `agy` in your current terminal session. Any arguments following `--` are forwarded to `agy`. Upon exit, any refreshed tokens are persisted back to the profile vault.

Recommendation: use `use` to configure your default background profile, and use `run` when starting an interactive coding session immediately.

## Command Reference

| Command | Description | Aliases |
| --- | --- | --- |
| `agyp adopt [--label <name>]` | Save the current active `agy` sign-in as a saved profile | `save`, `capture`, `claim` |
| `agyp login [--label <name>]` | Clear active credential, launch `agy` to sign in, and capture result | `add`, `signin`, `auth` |
| `agyp list [--json]` | List saved profiles with status indicator on the active account | `ls`, `show`, `all` |
| `agyp use <target>` | Set a saved profile as the active account for `agy` | `switch`, `select`, `set` |
| `agyp run [target] [-- args]` | Switch profile and launch `agy`; passes trailing arguments to `agy` | `start`, `exec`, `launch` |
| `agyp auto` | Automatically select and switch to the healthiest profile with maximum quota | `best`, `pick` |
| `agyp autorun [-- args]` | Automatically select healthiest profile and launch `agy` immediately | `auto-run` |
| `agyp usage [target] [--all]` | Display model quota and prompt credits (defaults to all profiles) | `quota`, `credits`, `limits` |
| `agyp plan` / `agyp stats` | Aggregate usage statistics, subscription tiers, and combined credits | `statistics`, `metrics` |
| `agyp update [--check]` | Update the `agy` CLI and report model lineup modifications | `upgrade`, `sync-models` |
| `agyp status [--json]` | Show current authentication state, token expiration, and vault status | `info`, `st`, `whoami` |
| `agyp label <target> [name]` | Set, update, or clear (`--clear`) a profile's friendly label | `rename`, `tag`, `alias` |
| `agyp remove <target>` | Delete a profile and remove its credentials from the vault | `rm`, `delete`, `del`, `unlink` |
| `agyp doctor` | Run health checks on keyring, binary location, and storage backends | `check`, `health` |
| `agyp spinner [seconds]` | Run interactive terminal loading spinner diagnostic demo | `spin`, `loading` |

### Target Resolution

A `<target>` argument specifies a profile using any of the following formats:
- Email address (e.g. `alex.work@gmail.com`)
- Friendly label (e.g. `work`)
- List number (e.g. `1` or `2`)
- Unique email prefix (e.g. `alex.work`)

Labels cannot consist entirely of numbers, as numeric arguments resolve to list positions.

### Options

- `--json`: Outputs structured JSON data for `list`, `usage`, `status`, and `stats`.
- `--models`: Displays detailed individual model breakdown alongside quota groups in `usage`.
- `--force`: Proceeds with profile switching or updating even if an `agy` process is running.
- `--default-browser`: Bypasses Chrome guest mode and opens authentication in your default system browser.

## Operational Architecture

### Browser Isolation During Sign-In

`agy` initiates authentication through standard Google web flows. Under normal browser settings, this flow automatically selects whichever account is currently signed in to your primary browser profile. `agyp login` (and re-authentication during `agyp run`) routes sign-in requests through a temporary Chrome guest window (`--guest`). This ensures cookies and active sessions remain completely isolated. If Google Chrome or Chromium is unavailable, `agyp` falls back to the system default browser.

### Credential Synchronization and Safety

When `agy` runs, it refreshes access tokens and writes updates directly to the OS keyring. To ensure refreshed credentials are never lost, `agyp` performs an automatic sync-back step before every profile switch and after every `agyp run`. Rather than assuming active credentials belong to the recorded active profile, `agyp` verifies token fingerprints and queries Google identity services directly when needed, preventing account corruption.

### Process Concurrency Gating

Because an active `agy` session periodically rewrites its keyring entry upon token refresh, modifying credentials while `agy` is running would allow the existing process to overwrite the newly activated profile. `agyp` inspects running system processes and prevents switching while `agy` is active. Use `--force` if you intentionally wish to bypass this check.

### Quota Resolution and Grouping

`agyp usage` communicates with Google Cloud Code endpoints concurrently using each profile's individual refresh token. Quotas are pooled into shared capacity groups (such as Gemini models and third-party Claude/GPT models) with weekly and five-hour rolling windows. If Google omits remaining capacity indicators for a pool, `agyp` displays `n/a` to preserve accuracy.

### Dynamic Model Catalog Tracking

Model availability and names evolve over time. `agyp` hardcodes no model identifiers or display names; it parses API catalog responses dynamically. To keep changes transparent, `agyp` stores the last observed catalog state in `~/.agy-profiler/models.json` and reports detected additions, renames, and retirements after running `agyp update`.

## Storage Architecture

| Data Item | Storage Location |
| --- | --- |
| Profile tokens | OS keyring (service `agy-profiler`), or file fallback in `~/.agy-profiler/secrets/` (0600) |
| Profile metadata | `~/.agy-profiler/profiles.json` (0600) |
| Model catalog cache | `~/.agy-profiler/models.json` (0600) |
| Live `agy` credential | OS keyring (`gemini:antigravity`), or `~/.gemini/antigravity-cli/antigravity-oauth-token` |

Set the `AGYP_HOME` environment variable to override the default profile directory (`~/.agy-profiler`).

Settings, prompt history, skills, plugins, and workspace configuration reside in `~/.gemini/` and remain shared across all profiles.

## Development

```bash
# Type check TypeScript source
npm run typecheck

# Execute unit test suite
npm test

# Build distribution bundle
npm run build
```

For complete technical specifications and internal mechanics, refer to [ARCHITECTURE.md](ARCHITECTURE.md).

## License

MIT. This project is not affiliated with or endorsed by Google. `agyp` interfaces with internal Antigravity CLI service endpoints.
