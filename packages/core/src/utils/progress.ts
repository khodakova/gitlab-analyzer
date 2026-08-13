/**
 * In-place progress/status renderer for the CLI.
 *
 * The tool writes user-facing status lines (pre-search repo list, progress,
 * summary, errors) to **stderr** while keeping **stdout** clean for the
 * pipeable report.
 *
 * Two output modes are supported, chosen by the `isTty` flag:
 *
 * - **TTY (interactive terminal, `process.stderr.isTTY`)** — the progress line
 *   *live-updates in place*: a carriage return (`\r`) plus a spinner glyph lets
 *   one dynamic line change as work proceeds. Before any static line is printed
 *   the active line is cleared so the two never interleave.
 * - **Non-TTY (piped / redirected / IDE log)** — carriage-return rewriting does
 *   NOT work (the consumer treats CR as a line break or drops it), so a live
 *   single line is impossible. Instead the renderer prints progress frames as
 *   ordinary newline-terminated lines, **deduplicated** (a repeated frame is a
 *   no-op) so a spinner timer does not spam identical lines.
 *
 * The renderer is deliberately framework-agnostic: it only knows about "a line
 * that is being redrawn in place" vs "a line that stays", so the same primitive
 * can serve a spinner on stage 1, per-repo progress on stage 2, etc. — the
 * caller decides what text to render.
 *
 * @example
 * ```ts
 * const p = new ProgressRenderer(); // auto-detects stderr TTY
 * p.spin('Обработано 1 из 5');      // TTY: rewrites the line; non-TTY: prints (dedup)
 * p.spin('Обработано 2 из 5');
 * p.static('Wrote 2 repo(s) to out.json'); // TTY: clears then prints; non-TTY: prints
 * p.end();
 * ```
 */
export class ProgressRenderer {
  /** Spinner glyphs cycled from one `spin(label)` call to the next (TTY only). */
  private static readonly SPINNER = ['|', '/', '-', '\\'];

  /** Whether in-place rewriting is supported (true terminal). */
  private readonly isTty: boolean;
  /** Longest content drawn since the last clear — used to blank stale chars. */
  private lastLength = 0;

  /** True when an active (in-place) line is currently on screen (TTY only). */
  private active = false;

  /** Last label passed to `spin`, used to detect a repeated label (animation). */
  private lastLabel: string | null = null;

  /** Current index into {@link SPINNER}. */
  private spinnerPhase = 0;

  /**
   * Last frame actually printed. In non-TTY mode `spin` with an unchanged frame
   * is a no-op (otherwise a spinner timer would spam identical lines).
   */
  private lastPrinted: string | null = null;

  /**
   * @param isTty - Whether stderr is a real terminal that handles `\r`
   *   rewriting. Defaults to `process.stderr.isTTY === true`; override in tests.
   */
  constructor(isTty: boolean = process.stderr.isTTY === true) {
    this.isTty = isTty;
  }

  /** Whether this renderer is in interactive (in-place rewriting) mode. */
  get tty(): boolean {
    return this.isTty;
  }

  /**
   * Write raw bytes to stderr. Virtualized so tests can capture output without
   * touching `process.stderr` (subclass and override).
   */
  protected writeRaw(chunk: string): void {
    process.stderr.write(chunk);
  }

  /**
   * Draw the live progress frame.
   *
   * - **TTY**: overwrite the current line with `\r` + spinner glyph + label,
   *   deduplicating nothing (each call re-renders to animate the glyph). If the
   *   label repeats, the spinner advances; a new label resets it. A longer
   *   previous frame is blanked with spaces so no stale tail remains.
   * - **Non-TTY**: print the frame as a newline-terminated line, unless it is
   *   identical to the last printed frame (no-op, so a spinner timer with an
   *   unchanged frame does not spam).
   */
  spin(label: string): void {
    if (this.isTty) {
      if (label === this.lastLabel) {
        this.spinnerPhase = (this.spinnerPhase + 1) % ProgressRenderer.SPINNER.length;
      } else {
        this.spinnerPhase = 0;
        this.lastLabel = label;
      }
      const glyph = ProgressRenderer.SPINNER[this.spinnerPhase];
      const content = `${glyph} ${label}`;
      const pad = this.lastLength - content.length;
      const padded = pad > 0 ? `${content}${' '.repeat(pad)}` : content;
      this.writeRaw(`\r${padded}`);
      this.lastLength = padded.length;
      this.active = true;
      return;
    }

    // Non-TTY: plain line, deduplicated.
    if (label === this.lastPrinted) {
      return;
    }
    this.lastPrinted = label;
    this.writeRaw(`${label}\n`);
  }

  /**
   * Clear the active progress line (TTY only). After this the cursor sits at
   * the start of a blank line so the next static line starts cleanly. No-op in
   * non-TTY mode.
   */
  clear(): void {
    if (!this.isTty) {
      return;
    }
    if (!this.active) {
      return;
    }
    if (this.lastLength > 0) {
      this.writeRaw(`\r${' '.repeat(this.lastLength)}\r`);
    }
    this.lastLength = 0;
    this.active = false;
    this.lastLabel = null;
  }

  /**
   * Print a *static* line that stays on screen.
   *
   * - **TTY**: clear any active progress line first, then write `line\n`.
   * - **Non-TTY**: write `line\n` directly (there is nothing to clear).
   *
   * This is the only path ordinary CLI output (repo list, summary, errors) goes
   * through.
   */
  static(line: string): void {
    this.clear();
    this.writeRaw(`${line}\n`);
  }

  /**
   * Finish the progress with a final, permanent frame: print `content` as a
   * normal static line (in TTY mode the live line is cleared first, so the log
   * ends with a clean final frame before the summary).
   */
  finish(content: string): void {
    this.static(content);
  }

  /**
   * Release any state. There is nothing to flush or restore today, but the
   * method exists so callers have a symmetric shutdown hook.
   */
  end(): void {
    // Explicitly no-op: leaving a dangling live line is handled by `clear()`
    // being invoked before the final static output.
  }
}
