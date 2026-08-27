import { ProgressRenderer } from '@gitlab-analyzer/core/internal';

/**
 * Single shared renderer for all CLI status output that goes to stderr and is
 * NOT gated by `--enable-logs`: progress (in-place dynamic line), summaries,
 * and the pre-search repo list. These are user-facing status lines that stay
 * visible regardless of verbosity. Debug/API/recovery output lives in the
 * central logger (`src/utils/logger.ts`) and is gated separately.
 *
 * The renderer is the single point of write for these lines: any static line
 * it prints clears the active in-place progress line first, so a live frame
 * never interleaves with ordinary output.
 */
export const progress = new ProgressRenderer();

/**
 * Print a static (non-overwritten) status line to stderr. Routes through the
 * {@link progress} renderer so any active dynamic progress line is cleared
 * before this line is written.
 */
export function report(line: string): void {
  progress.static(line);
}

/**
 * Compose the live progress frame shown on the single dynamic stderr line.
 *
 * The frame is `Processed N of M` (N = repos finished, M = total), and when a
 * repo has been started it is followed by ` · <name>` of the most recently
 * *started* repo — the `onRepoStart` hook reveals which repo is being worked on
 * right now, whereas `onProgress` only fires on completion.
 *
 * @param done - Repos processed so far (1-based, from `onProgress`).
 * @param total - Total repos to process.
 * @param lastStarted - The repo most recently started (from `onRepoStart`);
 *   omitted while nothing has been started yet.
 */
export function renderProgressFrame(
  done: number,
  total: number,
  lastStarted?: string,
): string {
  const prefix = `Processed ${done} of ${total}`;
  return lastStarted !== undefined ? `${prefix} · ${lastStarted}` : prefix;
}
