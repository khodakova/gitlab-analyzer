import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

/**
 * Asks the user for confirmation through stdin.
 *
 * @param message the question text.
 * @returns `true` if the user answered `y`/`yes` (case-insensitive).
 */
export async function userConfirm(message: string): Promise<boolean> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await readline.question(`${message} [y/N]: `)).trim();
    return /^y(es)?$/i.test(answer);
  } finally {
    readline.close();
  }
}
