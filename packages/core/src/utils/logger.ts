import { cyan, green, yellow, red, gray } from 'colorette';

/**
 * Central logger for `gitlab-analyzer`.
 *
 * This is a module-level singleton so every layer (CLI, utils, api) can log
 * through one place without threading a flag through every function signature.
 * Enabled/disabled state is configured once at startup via
 * {@link configureLogger}.
 *
 * Levels and visibility:
 *
 * - {@link logger.debug} — per-file / per-project detail (download progress,
 *   archive size/status, unzip steps). Gated by `enabled`: a no-op when logs
 *   are disabled. Enabled by `--enable-logs` (or `ENABLE_LOGS` /
 *   `defaults.enableLogs`) **or** by `--interactive`.
 * - {@link logger.info} — phase boundaries (`ℹ` blue). Always printed.
 * - {@link logger.success} — completions (`✓` green). Always printed.
 * - {@link logger.warn} — recoverable problems (`⚠` yellow). Always printed.
 * - {@link logger.error} — fatal failures (`✗` red). Always printed, so
 *   failures are never silently swallowed.
 *
 * All levels write to **stderr**, keeping stdout clean for the pipeable JSON
 * result emitted by the CLI. Writes go through a sequential queue so lines do
 * not interleave halfway even under parallelism — each line is its own write.
 *
 * Colors come from `colorette` (auto-detects TTY / `NO_COLOR`). The level
 * symbols (`✓`/`⚠`/`ℹ`/`✗`/`[debug]`) are plain unicode, not ANSI, so they
 * stay readable in a UTF-8 log file.
 */
type LoggerOptions = {
  /** Master switch for {@link logger.debug}. `false` mutes debug output. */
  enabled: boolean;
};

/** Logging levels understood by {@link logger}. */
type LogLevel = 'debug' | 'info' | 'success' | 'warn' | 'error';

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

// Sequential write queue. We deliberately do NOT rely on the `process.stderr.write`
// callback: vitest mocks frequently do `mockImplementation(() => true)` and never
// invoke the callback, which would deadlock a callback-chained queue. Order is
// guaranteed by JS single-threadedness — each short string is atomic at the OS
// level — and the queue merely preserves ordering and prevents lines from
// "overtaking" each other.
let writeChain: Promise<void> = Promise.resolve();
function schedule(line: string): void {
  // TTY: the progress spinner keeps an active line without a trailing newline
  // (it rewrites in place with \r). Clear that line first so log lines don't
  // interleave with the spinner — each log gets its own clean line.
  const clear = process.stderr.isTTY ? '\r\x1b[2K' : '';
  writeChain = writeChain
    .then(() => {
      process.stderr.write(`${clear}${line}\n`);
    })
    .catch(() => {
      /* a non-leading write error must not break the queue */
    });
}

function render(level: LogLevel, line: string): string {
  switch (level) {
    case 'debug':   return gray(`[debug] ${line}`);
    case 'info':    return cyan(`ℹ ${line}`);
    case 'success': return green(`✓ ${line}`);
    case 'warn':    return yellow(`⚠ ${line}`);
    case 'error':   return red(`✗ ${line}`);
  }
}

export const logger = {
  /**
   * Debug / per-file output. Printed only when the logger is enabled (see
   * {@link configureLogger}); otherwise a no-op. Prefixes the line with
   * `[debug]` so it is unmistakably debug output.
   */
  debug(line: string): void {
    if (enabled) schedule(render('debug', line));
  },

  /** Informational / phase output (`ℹ` blue). Always printed. */
  info(line: string): void {
    schedule(render('info', line));
  },

  /** Completion output (`✓` green). Always printed. */
  success(line: string): void {
    schedule(render('success', line));
  },

  /** Recoverable warning (`⚠` yellow). Always printed. */
  warn(line: string): void {
    schedule(render('warn', line));
  },

  /** Fatal error (`✗` red). Always printed, never swallowed. */
  error(line: string): void {
    schedule(render('error', line));
  },
};

/** Wait for the write queue to drain (call before `process.exit`). */
export function flushLogs(): Promise<void> {
  return writeChain;
}

/** Format a duration in milliseconds as a compact latin-`s` string. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}
