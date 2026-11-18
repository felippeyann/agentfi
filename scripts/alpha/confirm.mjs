/**
 * The destructive-target confirmation shared by `alpha:framework` and `alpha:serve` (same rule as `alpha:demo`):
 * print the banner of what will be wiped; the documented defaults need no question; other targets need `--yes`,
 * or typing "wipe" in an interactive terminal; without a terminal and without --yes the answer is no.
 */
import { createInterface } from 'node:readline/promises';
import { isDefaultTarget, scopeBanner } from './guard.mjs';

export async function confirmWipe({ databaseUrl, redisUrl, assumeYes, log = console.log }) {
  log(`\n${scopeBanner(databaseUrl, redisUrl)}\n`);
  if (isDefaultTarget(databaseUrl, redisUrl) || assumeYes) return true;
  if (!process.stdin.isTTY) {
    log('The targets are not the documented defaults and this is not an interactive terminal: refusing. Re-run with --yes to confirm the wipe above.');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('These are not the documented defaults. Type "wipe" to continue: ');
  rl.close();
  return answer.trim() === 'wipe';
}
