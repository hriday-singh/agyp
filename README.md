# agyp — multi-account profiles for the Antigravity CLI

`agy` supports one signed-in Google account at a time. `agyp` keeps as many as you
want, switches between them in a second, and shows model quota for all of them
without switching at all.

Works on Windows and Linux (macOS best-effort). No runtime dependencies.

```
$ agyp list
●  1. you@gmail.com                 personal  last used 2026-08-10
○  2. you.work@gmail.com            work      last used 2026-08-09

$ agyp usage
you@gmail.com (Google AI Pro)
  Claude Opus 4.6 (Thinking)   ████████████████░░░░   79%  resets in 3h 51m
  Gemini 3.1 Pro (High)        ────────────────────    n/a  resets in 1d 11h
...
```

## Install

```bash
npm install
npm run build
npm link          # puts `agyp` on your PATH
```

Requires Node 18+ and the `agy` CLI on your PATH.

On Linux you also need a Secret Service keyring — that is what `agy` itself uses:

```bash
sudo apt install libsecret-tools      # Debian/Ubuntu
sudo dnf install libsecret            # Fedora
```

with `gnome-keyring` or `kwallet` running. `agyp doctor` tells you if it is not.

## Getting started

```bash
agyp adopt --label personal   # save the account you are already signed into
agyp login --label work       # add a second one (signs you in through agy)
agyp list                     # see them, and which one is live
agyp label 1 hello            # set profile #1's label to "hello"
agyp label work job           # rename label "work" to "job"
agyp use job                  # switch
agyp run personal             # switch and launch agy in one go
agyp usage                    # quota for every account (default)
agyp usage job                # quota for one of them
```

`adopt` first — it captures your existing session, so you never have to re-login
for accounts you already use.

### `use` vs `run`

`agyp help use` prints this at any time.

- **`use <target>`** swaps the credential and exits. `agy` is not started; the next
  time you start it yourself — any terminal, or the Antigravity editor — it comes
  up as that account and stays there until you switch again.
- **`run [target] [-- args]`** swaps (only if you name a target) and then launches
  `agy` right there, attached to your terminal. Everything after `--` goes to `agy`
  untouched, and any token it refreshes is written back on exit.

Rule of thumb: `use` to change the default account, `run` to start a session now.

## Commands

| Command | What it does |
| --- | --- |
| `agyp adopt [--label <name>]` | Save whatever account `agy` is signed into right now as a profile (aliases: `save`, `capture`) |
| `agyp login [--label <name>]` | Add an account: clears `agy`'s credential, runs `agy` so you can sign in (in a Chrome guest window), captures the result (aliases: `add`, `signin`) |
| `agyp list` | Profiles, with a `●` on the one `agy` is using (aliases: `ls`, `show`, `all`) |
| `agyp use <target>` | Make a profile the active account (aliases: `switch`, `select`, `set`) |
| `agyp run [target] [-- args]` | Switch (if a target is given) and launch `agy`; anything after `--` is passed to `agy` (aliases: `start`, `exec`) |
| `agyp usage [target]` | Model quota and reset timers. No target = every profile (aliases: `quota`, `credits`) |
| `agyp plan` | Aggregate plan statistics, combined prompt credits, model quota pools, and recommended account (aliases: `stats`, `statistics`) |
| `agyp update [--check]` | Update the `agy` CLI, then report which models were added, renamed or removed (aliases: `upgrade`) |
| `agyp status` | What `agy` is authenticated as, and whether it matches a saved profile (aliases: `info`, `st`, `whoami`) |
| `agyp label <target> [name]` | Set, update (e.g. `agyp label 1 hello`, alias: `rename`, `tag`), or remove (`--clear`) a profile's label |
| `agyp remove <target>` | Forget a profile and delete its tokens from the keyring (aliases: `rm`, `delete`, `del`) |
| `agyp doctor` | Keyring backend, `agy` binary, vault health (aliases: `check`, `health`) |

A **target** is an email, a list number, a label, or an unambiguous email prefix —
`agyp use 2`, `agyp use work`, and `agyp use you.work@gmail.com` are the same thing.
Labels cannot be numbers only (e.g. `"123"` is rejected because numbers resolve to list positions).

`--json` works on `list`, `usage`, and `status`. `--all` on `usage` still works; it
is now the default.

## Things worth knowing

**Sign-in happens in a Chrome guest window.** `agy`'s login is an ordinary Google
web session, so in your normal browser it would pick up whichever account is
already signed in there — and leave the new one signed in afterwards. `agyp login`
(and `agyp run`, if `agy` asks you to re-authenticate) sends that page to a Chrome
guest window instead: no shared cookies in either direction, nothing left behind
when you close it. Chromium counts (`chromium` / `chromium-browser` on Linux —
`--guest` is a Chromium flag). Pass `--default-browser` to opt out, which is also
what happens automatically when no Chrome/Chromium is found.

**Quota with no target means every account.** `agyp usage` shows all profiles;
name one (`agyp usage work`) to narrow it.

**Re-authentication is contained.** If `agy` makes you sign in again, that only
touches the profile you are on. Before every switch, `agyp` writes the live
credential back into the profile that owns it, so refreshed (or re-issued) tokens
are never lost — and it identifies the token with Google rather than assuming,
so a mid-session `/login` as a *different* account can't overwrite the wrong
profile.

**Switching is blocked while `agy` runs.** A running `agy` rewrites its credential
whenever the token refreshes, which would overwrite whatever you just switched to.
Close it, or pass `--force` if you know what you are doing.

**Quota needs no switching.** `agyp usage` talks to Google directly with each
profile's own token. Nothing about your live session changes.

**`n/a` in the quota column is honest.** Google omits the remaining-fraction field
for pools it has nothing to report on. `agyp` shows `n/a` instead of guessing
100%. The reset timer is still accurate.

**Model renames never break anything.** No model name is hardcoded anywhere —
`usage` shows whatever the API returns, so models that appear, disappear or get
renamed flow through with no code change. `agyp update` exists to make that
visible rather than silent:

```
$ agyp update
agy 1.1.11 — running `agy update`
updated agy 1.1.11 -> 1.2.0

model changes:
  + new    Gemini 4 Flash (gemini-4-flash)
  ~ renamed Gemini 3.1 Pro (High) -> Gemini 3.5 Pro (High) (gemini-3.1-pro-high)
  - gone   GPT-OSS 120B (Medium) (gpt-oss-120b-medium)
```

Renames are detected by model **id**, not display name, so a rebrand shows up as
a rename rather than as one model vanishing and another appearing. `agyp usage`
also notices drift and points you at `agyp update --check`.

**Only auth is per-profile.** Settings, history, skills, plugins, MCP servers and
trusted workspaces live in `~/.gemini/` and are shared by every profile — which is
almost always what you want.

## Where things are stored

| What | Where |
| --- | --- |
| Profile tokens | OS keyring, service `agy-profiler`, one entry per email |
| Profile metadata (no secrets) | `~/.agy-profiler/profiles.json` |
| Last-seen model catalog | `~/.agy-profiler/models.json` |
| `agy`'s live credential | OS keyring, service `gemini`, account `antigravity` |

No token is ever written to disk in plaintext. `AGYP_HOME` overrides the metadata
directory.

## Development

```bash
npm run typecheck
npm test
npm run build
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for how it works and where to extend it.
