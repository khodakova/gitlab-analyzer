/**
 * Central logger for `gitlab-analyzer`.
 *
 * This is a module-level singleton so every layer (CLI, utils, api) can log
 * through one place without threading a flag through every function signature.
 * Enabled/disabled state is configured once at startup via
 * {@link configureLogger}.
 *
 * Two levels are exposed:
 *
 * - {@link logger.debug} — informational / API / per-project recovery output.
 *   Gated by `enabled`: it is a no-op when logs are disabled. Enabled by
 *   `--enable-logs` (or `ENABLE_LOGS` / `defaults.enableLogs`) **or** by
 *   `--interactive` (interactive mode turns the full log on).
 * - {@link logger.error} — always printed (regardless of `enabled`), so
 *   failures are never silently swallowed.
 *
 * Both levels write to **stderr**, keeping stdout clean for the pipeable JSON
 * result emitted by the CLI.
 */
type LoggerOptions = {
  /** Master switch for {@link logger.debug}. `false` mutes debug output. */
  enabled: boolean;
};

let enabled = false;

/**
 * Configure the global logger state. Call once at startup (the CLI calls it
 * with the resolved `enableLogs || interactive` value; library consumers may
 * call it to turn debug logging on). Defaults to `enabled: false`.
 */
export function configureLogger(options: LoggerOptions): void {
  enabled = options.enabled;
}

/** Whether debug logging is currently enabled (so callers can skip extra work). */
export function isLoggingEnabled(): boolean {
  return enabled;
}

function write(line: string): void {
  // TTY: the progress spinner keeps an active line without a trailing newline
  // (it rewrites in place with \r). Clear that line first so debug/error lines
  // don't interleave with the spinner — each log gets its own clean line.
  const clear = process.stderr.isTTY ? '\r\x1b[2K' : '';
  process.stderr.write(`${clear}${line}\n`);
}

export const logger = {
  /**
   * Debug / informational output. Printed only when the logger is enabled
   * (see {@link configureLogger}); otherwise a no-op.
   */
  debug(line: string): void {
    if (enabled) write(line);
  },

  /**
   * Error output. Always printed, regardless of whether the logger is
   * enabled — errors must never be silently swallowed.
   */
  error(line: string): void {
    write(line);
  },
};
