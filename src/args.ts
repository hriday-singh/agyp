import { ALL_COMMAND_NAMES, COMMAND_ALIASES } from './suggest.js';

/** Argument parsing. Small enough that a dependency would cost more than it saves. */

export class UserError extends Error {}

export interface Parsed {
  command: string;
  /** Positional arguments after the command. */
  positional: string[];
  /** `--foo` boolean flags, without the dashes. */
  flags: Set<string>;
  /** `--label x` style options. */
  options: Map<string, string>;
  /** Everything after a bare `--`, forwarded to agy untouched. */
  passthrough: string[];
}

const VALUE_OPTIONS = new Set(['label']);
const KNOWN_COMMANDS = new Set(ALL_COMMAND_NAMES);

function isLabelCommand(cmd: string): boolean {
  const primary = COMMAND_ALIASES[cmd] ?? cmd;
  return primary === 'login' || primary === 'adopt';
}


export function parseArgs(argv: string[]): Parsed {
  const separator = argv.indexOf('--');
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const passthrough = separator === -1 ? [] : argv.slice(separator + 1);

  const flags = new Set<string>();
  const options = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < own.length; i++) {
    const arg = own[i]!;
    if (arg === '-h') {
      flags.add('help');
    } else if (arg === '-d') {
      flags.add('default-browser');
    } else if (arg.startsWith('--')) {
      const name = arg.slice(2);
      let optName = name;
      let optVal: string | undefined;
      const eqIdx = name.indexOf('=');
      if (eqIdx !== -1) {
        optName = name.slice(0, eqIdx);
        optVal = name.slice(eqIdx + 1);
      }

      if (VALUE_OPTIONS.has(optName)) {
        const value = optVal !== undefined ? optVal : own[++i];
        if (!value) throw new UserError(`--${optName} needs a value`);
        options.set(optName, value);
      } else if (optName === 'browser' || optName === 'system-browser' || optName === 'no-guest') {
        flags.add('default-browser');
      } else {
        flags.add(optName);
      }
    } else {
      positional.push(arg);
    }
  }

  let command = (positional[0] ?? 'help').toLowerCase();
  let remainingPositional = positional.slice(1);

  // If the invocation is `<label> login` (e.g. `agyp pa login` or `agyp work add`),
  // normalize so command is `login` and label is `pa`.
  if (positional.length >= 2 && !KNOWN_COMMANDS.has(positional[0]!.toLowerCase())) {
    const candidate = positional[1]!.toLowerCase();
    if (isLabelCommand(candidate)) {
      command = candidate;
      if (!options.has('label')) {
        options.set('label', positional[0]!);
      }
      remainingPositional = positional.slice(2);
    }
  }

  // If the invocation is `login <label>` (e.g. `agyp login pa` or `agyp adopt work`),
  // extract the positional label if --label was not explicitly given.
  if (isLabelCommand(command) && !options.has('label') && remainingPositional.length > 0) {
    options.set('label', remainingPositional[0]!);
    remainingPositional = remainingPositional.slice(1);
  }

  return { command, positional: remainingPositional, flags, options, passthrough };
}

