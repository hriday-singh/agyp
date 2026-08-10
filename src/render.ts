/** Terminal output. Plain ANSI, no dependencies, degrades to plain text when piped. */
import type { Snapshot } from './google.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const ESC = String.fromCharCode(27);

const paint = (code: string) => (s: string) => (useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s);
export const dim = paint('2');
export const bold = paint('1');
export const green = paint('32');
export const yellow = paint('33');
export const red = paint('31');
export const cyan = paint('36');

/**
 * Braille spinner while the network is in flight. Writes to stderr so `--json`
 * piped out of stdout stays machine-readable, and no-ops when stderr is not a
 * TTY (CI logs, redirects). Returns the stop function.
 */
export function spinner(text: string): () => void {
  const isTTY = Boolean((process.stderr.isTTY || process.stdout.isTTY) && !process.env['NO_COLOR']);
  if (!isTTY) return () => {};
  const stream = process.stderr.isTTY ? process.stderr : process.stdout;
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const draw = () => stream.write(`\r${frames[i++ % frames.length]} ${text}`);
  draw();
  const timer = setInterval(draw, 80);
  timer.unref?.(); // never hold the process open on its own
  return () => {
    clearInterval(timer);
    stream.write(`\r${' '.repeat(text.length + 10)}\r`);
  };
}

export function humanDuration(ms: number): string {
  if (ms <= 0) return 'now';
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

export function bar(fraction: number, width = 20): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  const glyphs = '█'.repeat(filled) + '░'.repeat(width - filled);
  const tint = clamped > 0.5 ? green : clamped > 0.2 ? yellow : red;
  return tint(glyphs);
}

export function renderSnapshot(snapshot: Snapshot): string {
  const lines: string[] = [];
  const plan = snapshot.planType ? dim(` (${snapshot.planType})`) : '';
  lines.push(bold(snapshot.email) + plan);

  if (snapshot.promptCredits) {
    const { available, monthly, remainingPercentage } = snapshot.promptCredits;
    lines.push(`  ${'Prompt credits'.padEnd(34)} ${bar(remainingPercentage)} ${available}/${monthly}`);
  }

  if (snapshot.models.length === 0) {
    lines.push(dim('  no models with quota info'));
    return lines.join('\n');
  }

  for (const model of snapshot.models) {
    const name = model.label.length > 32 ? model.label.slice(0, 31) + '…' : model.label;
    const fraction = model.remainingPercentage;
    const gauge = fraction === undefined ? dim('─'.repeat(20)) : bar(fraction);
    const pct = fraction === undefined ? dim('   n/a') : `${(fraction * 100).toFixed(0).padStart(4)}%`;
    const reset = model.timeUntilResetMs ? dim(`resets in ${humanDuration(model.timeUntilResetMs)}`) : '';
    const flag = model.isExhausted ? red(' EXHAUSTED') : '';
    lines.push(`  ${name.padEnd(34)} ${gauge} ${pct}  ${reset}${flag}`);
  }
  return lines.join('\n');
}
