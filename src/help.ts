import { bold } from './render.js';

export const USE_VS_RUN = `${bold('USE vs RUN')}
  ${bold('use')} only swaps the credential and exits. agy is not started; the next time you
  start agy yourself — from any terminal, or from the Antigravity editor — it comes
  up as that account, and stays there until you switch again. It refuses to run
  while agy is open, because a running agy rewrites the credential on token
  refresh and would undo the swap.

  ${bold('run')} swaps (only if you name a target) and then launches agy right there,
  attached to your terminal. Everything after ${bold('--')} is handed to agy untouched.
  When agy exits, any token it refreshed is written back to that profile. With no
  target it launches agy as whoever is already active.

  Rule of thumb: ${bold('use')} to change the default account, ${bold('run')} to start a session now.
`;

export const HELP = `${bold('agyp')} — profile manager for the Antigravity CLI

${bold('USAGE')}
  agyp <command> [target] [options]

  A ${bold('target')} is an email, a list number, a label, or an email prefix.

${bold('COMMANDS')}
  adopt [--label <name>]     Save current agy login as profile (aliases: save, capture, claim)
  login [--label <name>]     Add a new account profile (aliases: add, signin, auth)
  list                       List saved profiles and active one (aliases: ls, show, all)
  use <target>               Make a profile agy's active account (aliases: switch, select, set)
  run [target] [-- args]     Switch profile and launch agy CLI (aliases: start, exec, launch)
  auto                       Auto-select and switch to the healthiest profile (aliases: best, pick)
  autorun [-- args]          Auto-select healthiest profile and launch agy (aliases: auto-run)
  usage [target]             Show model quota (aliases: quota, credits, limits)
  update [--check]           Update agy CLI and check model lineup (aliases: upgrade, sync-models)
  status                     Show active profile and sync status (aliases: info, st, whoami)
  label <target> [name]      Set, update, or clear profile label (aliases: rename, tag, alias)
  remove <target>            Delete a profile (aliases: rm, delete, del, unlink)
  doctor                     Check system health and diagnostics (aliases: check, health)
  stats                      Usage & subscription plan statistics across profiles (aliases: plan, statistics, metrics)
  weekly [target]            Show weekly quota status and replenishment forecast (aliases: week, forecast, resets)
  spinner [seconds]          Show interactive loading spinner demo (aliases: spin, loading)

${USE_VS_RUN}
${bold('OPTIONS')}
  --all               usage/weekly: every saved profile (the default; kept for habit)
  --auto              use/run: automatically select the healthiest account
  --weekly            usage: view weekly quota breakdown and reset forecast
  --models            usage: display detailed per-model breakdown
  --check             update: only report model changes, do not update agy
  --json              usage/weekly/list/status: machine-readable output
  --label             adopt/login: a short name you can use as a target
  --clear             label: remove a profile's label
  --force             use/run/login: proceed even if agy appears to be running
  --default-browser   login/run: sign in in your normal browser instead of a
                      Chrome guest window
  -h, --help          This text, or \`agyp help <command>\` for command-specific help

${bold('EXAMPLES')}
  agyp adopt --label personal      # save the account you are already signed into
  agyp login --label work          # add a second account, in a guest Chrome window
  agyp label 1 hello               # label profile #1 as "hello"
  agyp label work personal         # rename label "work" to "personal"
  agyp label personal --clear      # remove label from personal profile
  agyp usage                       # quota across every account
  agyp usage work                  # quota for one account
  agyp run work                    # launch agy using work profile
  agyp spinner 6                   # run spinner for 6 seconds
`;

export const COMMAND_HELP: Record<string, string> = {
  adopt: `${bold('agyp adopt')} — Save current agy sign-in as a profile

${bold('USAGE')}
  agyp adopt [--label <name>]

${bold('DESCRIPTION')}
  Captures the credential currently used by agy and saves it into the vault as a profile.
  If --label is provided, the short name can be used as a target in other agyp commands.

${bold('OPTIONS')}
  --label <name>    Set a friendly label for the captured profile.
`,

  login: `${bold('agyp login')} — Add a new account profile

${bold('USAGE')}
  agyp login [--label <name>] [--force] [--default-browser] [-- <agy args>]

${bold('DESCRIPTION')}
  Clears agy's live credential, launches agy so you can sign in to a new account,
  and captures the result as a new saved profile.

  By default, sign-in opens in an isolated Chrome guest window to avoid interference
  with your default browser profile.

${bold('OPTIONS')}
  --label <name>      Set a friendly label for the new profile.
  --force             Proceed even if agy appears to be currently running.
  --default-browser   Open sign-in in your default system browser instead of Chrome guest window.
`,

  list: `${bold('agyp list')} — List all saved profiles

${bold('USAGE')}
  agyp list [--json]
  agyp ls [--json]

${bold('DESCRIPTION')}
  Displays all saved profiles in the vault, indicating which profile agy is currently using,
  along with labels and last-used dates.

${bold('OPTIONS')}
  --json    Output machine-readable JSON format.
`,

  use: `${bold('agyp use')} — Switch agy's active account profile

${bold('USAGE')}
  agyp use <target> [--force]
  agyp switch <target> [--force]

${bold('DESCRIPTION')}
  Swaps agy's live credential with the credential of the specified target profile.
  Target can be an email, 1-based list index, label, or email prefix.

${USE_VS_RUN}`,

  run: `${bold('agyp run')} — Switch profile and launch agy CLI

${bold('USAGE')}
  agyp run [target] [--force] [--default-browser] [-- <agy args>]
  agyp start [target] [--force] [--default-browser] [-- <agy args>]

${bold('DESCRIPTION')}
  Switches to the target profile (if specified) and launches agy right in your terminal.
  Everything after '--' is passed directly to agy.

${USE_VS_RUN}`,

  auto: `${bold('agyp auto')} — Automatically select and switch to the healthiest profile

${bold('USAGE')}
  agyp auto [--force]
  agyp best [--force]
  agyp use --auto [--force]

${bold('DESCRIPTION')}
  Checks quotas across all saved profiles, ranks them by health (zero/minimal exhausted
  models and highest remaining capacity), and activates the best profile.
`,

  autorun: `${bold('agyp autorun')} — Auto-select healthiest profile and launch agy

${bold('USAGE')}
  agyp autorun [--force] [--default-browser] [-- <agy args>]
  agyp auto-run [--force] [--default-browser] [-- <agy args>]
  agyp run --auto [--force] [--default-browser] [-- <agy args>]

${bold('DESCRIPTION')}
  Automatically selects and switches to the healthiest profile, then immediately launches
  the agy CLI attached to your terminal.
`,

  usage: `${bold('agyp usage')} — View model quota and prompt credits

${bold('USAGE')}
  agyp usage [target] [--all] [--json]
  agyp quota [target] [--all] [--json]

${bold('DESCRIPTION')}
  Fetches remaining model quota and prompt credits for saved profiles.
  Defaults to querying all saved profiles.

${bold('OPTIONS')}
  --all     Query all saved profiles (default behavior).
  --models  Display detailed per-model breakdown alongside groups.
  --json    Output machine-readable JSON snapshot format.
`,

  update: `${bold('agyp update')} — Update agy CLI and check model lineup changes

${bold('USAGE')}
  agyp update [--check] [--force]

${bold('DESCRIPTION')}
  Updates the agy CLI binary and checks if available models or quota tiers have changed.

${bold('OPTIONS')}
  --check    Only check for model lineup changes without updating agy.
  --force    Proceed even if agy is currently running.
`,

  status: `${bold('agyp status')} — Show active profile and sync status

${bold('USAGE')}
  agyp status [--json]

${bold('DESCRIPTION')}
  Displays the signed-in account in agy, access token expiration, vault index path,
  and whether agy's live credential matches a saved profile.

${bold('OPTIONS')}
  --json    Output machine-readable JSON status format.
`,

  label: `${bold('agyp label')} — Set, rename, or clear a profile's label

${bold('USAGE')}
  agyp label <target> [new-label] [--clear]
  agyp rename <target> <new-label>

${bold('DESCRIPTION')}
  Sets, updates, or removes the friendly label for a profile (e.g. \`agyp label 1 hello\` labels account #1 as "hello").
  Target can be an email, 1-based list index, existing label, or email prefix.
  Note: labels cannot be numbers only (e.g. "123" is forbidden because digits resolve to list numbers).

${bold('OPTIONS')}
  --clear    Remove the label from the specified profile.
`,

  remove: `${bold('agyp remove')} — Delete a profile and its stored credentials

${bold('USAGE')}
  agyp remove <target>
  agyp rm <target>

${bold('DESCRIPTION')}
  Deletes a profile from the vault index and removes its credentials from the system keyring.
`,

  doctor: `${bold('agyp doctor')} — Check system health and backend diagnostics

${bold('USAGE')}
  agyp doctor

${bold('DESCRIPTION')}
  Verifies OS keyring backend accessibility, agy binary presence on PATH,
  Node.js version requirements, vault index integrity, and process state.
`,

  stats: `${bold('agyp stats')} — View model quota, prompt credits, and plan statistics

${bold('USAGE')}
  agyp stats [--json] [--reset]
  agyp plan [--json] [--reset]
  agyp statistics [--json] [--reset]

${bold('DESCRIPTION')}
  Displays aggregate usage statistics across all saved accounts: subscription plans/tiers,
  combined prompt credits, average model quota capacity, and account recommendations.

${bold('OPTIONS')}
  --json     Output machine-readable JSON stats format.
  --reset    Clear cached usage statistics.
`,

  weekly: `${bold('agyp weekly')} — Show weekly quota status and replenishment forecast

${bold('USAGE')}
  agyp weekly [target] [--json]
  agyp week [target] [--json]
  agyp forecast [target] [--json]
  agyp usage [target] --weekly [--json]

${bold('DESCRIPTION')}
  Analyzes model quotas for each profile and handle, identifying the earliest upcoming
  quota reset and categorizing model pools into weekly/multi-day and rolling daily windows.

${bold('OPTIONS')}
  --json    Output machine-readable JSON format.
`,

  spinner: `${bold('agyp spinner')} — Show interactive loading spinner demo

${bold('USAGE')}
  agyp spinner [seconds]
  agyp spin [seconds]

${bold('DESCRIPTION')}
  Runs an interactive terminal spinner for the specified duration (default: 10s),
  switching between random status messages every 3 seconds.
`,
};

