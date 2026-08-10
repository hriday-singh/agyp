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
    } else if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (VALUE_OPTIONS.has(name)) {
        const value = own[++i];
        if (!value) throw new UserError(`--${name} needs a value`);
        options.set(name, value);
      } else {
        flags.add(name);
      }
    } else {
      positional.push(arg);
    }
  }

  return { command: positional[0] ?? 'help', positional: positional.slice(1), flags, options, passthrough };
}
