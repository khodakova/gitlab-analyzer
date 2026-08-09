import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

/**
 * Спрашивает у пользователя подтверждение через stdin.
 *
 * @param message текст вопроса.
 * @returns `true`, если пользователь ответил `y`/`yes` (регистр не важен).
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
