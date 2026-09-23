import type { ModelQuota, Snapshot } from './google.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const ESC = String.fromCharCode(27);

const paint = (code: string) => (s: string) => (useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s);
export const dim = paint('2');
export const bold = paint('1');
export const green = paint('32');
export const yellow = paint('33');
export const red = paint('31');
export const cyan = paint('36');

export interface SpinnerController {
  (): void;
  update: (newText: string) => void;
  /** Print a line above the spinner without smearing it. */
  log: (line: string) => void;
}

/**
 * Braille spinner while the network is in flight. Writes to stderr so `--json`
 * piped out of stdout stays machine-readable, and no-ops when stderr is not a
 * TTY (CI logs, redirects). Returns the stop function with an update method.
 */
export function spinner(text: string): SpinnerController {
  const isTTY = Boolean((process.stderr.isTTY || process.stdout.isTTY) && !process.env['NO_COLOR']);
  if (!isTTY) {
    const noop = (() => {}) as SpinnerController;
    noop.update = () => {};
    noop.log = (line: string) => console.log(line);
    return noop;
  }
  const stream = process.stderr.isTTY ? process.stderr : process.stdout;
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let currentText = text;
  let maxLen = text.length;

  const draw = () => {
    const line = `${frames[i++ % frames.length]} ${currentText}`;
    if (line.length > maxLen) maxLen = line.length;
    stream.write(`\r${line.padEnd(maxLen + 2, ' ')}`);
  };

  draw();
  const timer = setInterval(draw, 80);
  timer.unref?.(); // never hold the process open on its own

  const clear = () => stream.write(`\r${' '.repeat(maxLen + 10)}\r`);

  const stop = (() => {
    clearInterval(timer);
    clear();
  }) as SpinnerController;

  stop.log = (line: string) => {
    clear();
    stream.write(`${line}\n`);
    draw();
  };

  stop.update = (newText: string) => {
    currentText = newText;
    if (newText.length + 2 > maxLen) maxLen = newText.length + 2;
  };

  return stop;
}

/**
 * A full bucket's resetTime is just "now + window" — the window only starts on
 * first use — so a countdown there is noise that never gets closer.
 */
export function resetLabel(fraction: number | undefined, ms: number | undefined): string {
  if (!ms || (fraction !== undefined && fraction >= 1)) return '';
  return dim(`resets in ${humanDuration(ms)}`);
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

export function renderSnapshot(snapshot: Snapshot, showModels = false): string {
  const lines: string[] = [];
  const plan = snapshot.planType ? dim(` (${snapshot.planType})`) : '';
  lines.push(bold(snapshot.email) + plan);

  if (snapshot.promptCredits) {
    const { available, monthly, remainingPercentage } = snapshot.promptCredits;
    lines.push(`  ${'Prompt credits'.padEnd(34)} ${bar(remainingPercentage)} ${available}/${monthly}`);
  }

  if (snapshot.quotaGroups && snapshot.quotaGroups.length > 0) {
    for (const group of snapshot.quotaGroups) {
      lines.push(`\n  ${bold(cyan(group.displayName))}`);
      for (const bucket of group.buckets) {
        const fraction = bucket.remainingFraction;
        const gauge = fraction === undefined ? dim('─'.repeat(20)) : bar(fraction);
        const pct = fraction === undefined ? dim('   n/a') : `${(fraction * 100).toFixed(0).padStart(4)}%`;
        const reset = resetLabel(fraction, bucket.timeUntilResetMs);
        const flag = bucket.remainingFraction !== undefined && bucket.remainingFraction <= 0 ? red(' EXHAUSTED') : '';
        const name = bucket.displayName.length > 30 ? bucket.displayName.slice(0, 29) + '…' : bucket.displayName;
        lines.push(`    ${name.padEnd(32)} ${gauge} ${pct}  ${reset}${flag}`);
      }
      if (group.description) {
        lines.push(dim(`    ${group.description}`));
      }
    }

    const standalone = snapshot.models.filter((m) => !m.groupName);
    if (standalone.length > 0 && !showModels) {
      lines.push(bold('\n  Additional Models:'));
      for (const model of standalone) {
        const name = model.label.length > 32 ? model.label.slice(0, 31) + '…' : model.label;
        const fraction = model.remainingPercentage;
        const gauge = fraction === undefined ? dim('─'.repeat(20)) : bar(fraction);
        const pct = fraction === undefined ? dim('   n/a') : `${(fraction * 100).toFixed(0).padStart(4)}%`;
        const reset = resetLabel(fraction, model.timeUntilResetMs);
        const flag = model.isExhausted ? red(' EXHAUSTED') : '';
        lines.push(`    ${name.padEnd(32)} ${gauge} ${pct}  ${reset}${flag}`);
      }
    }

    if (showModels && snapshot.models.length > 0) {
      lines.push(bold('\n  Models:'));
      for (const model of snapshot.models) {
        const name = model.label.length > 32 ? model.label.slice(0, 31) + '…' : model.label;
        const fraction = model.remainingPercentage;
        const gauge = fraction === undefined ? dim('─'.repeat(20)) : bar(fraction);
        const pct = fraction === undefined ? dim('   n/a') : `${(fraction * 100).toFixed(0).padStart(4)}%`;
        const reset = resetLabel(fraction, model.timeUntilResetMs);
        const flag = model.isExhausted ? red(' EXHAUSTED') : '';
        lines.push(`    ${name.padEnd(32)} ${gauge} ${pct}  ${reset}${flag}`);
      }
    }
    return lines.join('\n');
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
    const reset = resetLabel(fraction, model.timeUntilResetMs);
    const flag = model.isExhausted ? red(' EXHAUSTED') : '';
    lines.push(`  ${name.padEnd(34)} ${gauge} ${pct}  ${reset}${flag}`);
  }
  return lines.join('\n');
}



