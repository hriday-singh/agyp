/**
 * Interactive spinner demo command and list of standard spinner status messages.
 */
import { UserError } from './args.js';
import { green, spinner } from './render.js';

export const SPINNER_TEXTS: readonly string[] = [
  'identifying account',
  'syncing current credential',
  'identifying new account',
  'loading profiles',
  'syncing credential',
  'syncing profile updates',
  'checking accounts',
  'checking model lineup',
  'identifying the signed-in account',
  'running health checks',
];

export function getRandomSpinnerText(exclude?: string): string {
  const pool = SPINNER_TEXTS.filter((t) => t !== exclude);
  if (pool.length === 0) return SPINNER_TEXTS[0] ?? 'working...';
  const index = Math.floor(Math.random() * pool.length);
  return pool[index]!;
}

export async function cmdSpinner(secondsArg?: string): Promise<void> {
  const secs = secondsArg !== undefined ? Number(secondsArg) : 10;
  if (isNaN(secs) || secs <= 0) {
    throw new UserError('spinner duration must be a positive number of seconds (e.g. `agyp spinner 5`)');
  }

  let currentText = getRandomSpinnerText();
  const stop = spinner(currentText);

  const durationMs = secs * 1000;
  const switchIntervalMs = 3000;

  return new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      currentText = getRandomSpinnerText(currentText);
      stop.update(currentText);
    }, switchIntervalMs);

    setTimeout(() => {
      clearInterval(interval);
      stop();
      console.log(`${green('completed')} spinner demo (${secs}s)`);
      resolve();
    }, durationMs);
  });
}
