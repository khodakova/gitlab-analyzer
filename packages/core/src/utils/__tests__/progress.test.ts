import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProgressRenderer } from '../progress.ts';

/**
 * Test subclass that captures output instead of touching the real stderr.
 */
class CapturingRenderer extends ProgressRenderer {
  public chunks: string[] = [];
  protected override writeRaw(chunk: string): void {
    this.chunks.push(chunk);
  }
}

const renderer = (isTty: boolean): CapturingRenderer =>
  new CapturingRenderer(isTty);
const text = (r: CapturingRenderer): string => r.chunks.join('');
// First frame always uses the starting glyph `|` (phase 0).
const frame = (label: string): string => `| ${label}`;

describe('ProgressRenderer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('TTY mode (in-place rewriting)', () => {
    it('spin writes a carriage-return frame (glyph + label) without a newline', () => {
      const r = renderer(true);
      r.spin('[1/3] first');
      expect(r.chunks[0]).toBe(`\r${frame('[1/3] first')}`);
    });

    it('spin replaces the previous frame in place (no extra newlines)', () => {
      const r = renderer(true);
      r.spin('[1/3] first');
      r.spin('[2/3] second');
      expect(text(r)).toBe(`\r${frame('[1/3] first')}\r${frame('[2/3] second')}`);
    });

    it('spin pads a shorter frame with spaces so no stale tail remains', () => {
      const r = renderer(true);
      r.spin('[1/3] a-very-long-repo-name');
      r.spin('[2/3] bo');
      const long = frame('[1/3] a-very-long-repo-name');
      const next = frame('[2/3] bo') + ' '.repeat(long.length - frame('[2/3] bo').length);
      expect(text(r)).toBe(`\r${long}\r${next}`);
    });

    it('a repeated label advances the spinner glyph (animation)', () => {
      const r = renderer(true);
      r.spin('loading');
      r.spin('loading'); // same label -> next phase `/`
      expect(text(r)).toBe('\r| loading\r/ loading');
    });

    it('a new label resets the spinner to its starting glyph', () => {
      const r = renderer(true);
      r.spin('aaa');
      r.spin('aaa');
      r.spin('bbb');
      expect(text(r)).toBe('\r| aaa\r/ aaa\r| bbb');
    });

    it('clear is a no-op when no active line is on screen', () => {
      const r = renderer(true);
      r.clear();
      expect(r.chunks).toHaveLength(0);
    });

    it('clear blanks an active line and returns the cursor', () => {
      const r = renderer(true);
      r.spin('[1/3] some-repo');
      r.clear();
      const active = frame('[1/3] some-repo');
      expect(text(r)).toBe('\r' + active + '\r' + ' '.repeat(active.length) + '\r');
    });

    it('clear after clear does not write again', () => {
      const r = renderer(true);
      r.spin('x');
      r.clear();
      const before = r.chunks.length;
      r.clear();
      expect(r.chunks.length).toBe(before);
    });

    it('clear resets the spinner state so the next spin starts at phase 0', () => {
      const r = renderer(true);
      r.spin('aaa');
      r.spin('aaa'); // phase -> `/`
      r.clear();
      r.spin('bbb'); // must start at `|` again (label also differs)
      expect(text(r)).toContain('\r| bbb');
    });

    it('static clears any active line before printing the line with a newline', () => {
      const r = renderer(true);
      r.spin('[1/3] repo');
      r.static('Wrote 1 repo(s) to out.json');
      const active = frame('[1/3] repo');
      const clear = '\r' + ' '.repeat(active.length) + '\r';
      expect(text(r)).toBe(
        `\r${active}${clear}Wrote 1 repo(s) to out.json\n`,
      );
    });

    it('static with no active line prints the line with a newline', () => {
      const r = renderer(true);
      r.static('plain');
      expect(text(r)).toBe('plain\n');
    });

    it('static clears the active frame state so the next spin starts clean', () => {
      const r = renderer(true);
      r.spin('[1/3] a-long-repo');
      r.static('done');
      r.spin('[2/3] bo');
      const active = frame('[1/3] a-long-repo');
      // After `static` cleared the long frame, a shorter spin must not pad to
      // the old length (lastLength was reset).
      expect(text(r)).toBe(
        '\r' + active + '\r' +
          ' '.repeat(active.length) +
          '\r' +
          'done\n' +
          '\r' + frame('[2/3] bo'),
      );
    });

    it('finish behaves like static (clears and pins a permanent line)', () => {
      const r = renderer(true);
      r.spin('[1/3] repo');
      r.finish('[3/3] repo');
      const active = frame('[1/3] repo');
      const clear = '\r' + ' '.repeat(active.length) + '\r';
      expect(text(r)).toBe(`\r${active}${clear}[3/3] repo\n`);
    });

    it('end is a no-op', () => {
      const r = renderer(true);
      r.end();
      expect(r.chunks).toHaveLength(0);
    });

    it('tty getter reflects mode', () => {
      expect(renderer(true).tty).toBe(true);
    });
  });

  describe('non-TTY mode (plain newline lines, no rewriting)', () => {
    it('spin prints the frame as a newline-terminated line (no \r, no glyph)', () => {
      const r = renderer(false);
      r.spin('Обработано 1 из 3');
      expect(text(r)).toBe('Обработано 1 из 3\n');
    });

    it('spin deduplicates an unchanged frame (spinner timer must not spam)', () => {
      const r = renderer(false);
      r.spin('Обработано 1 из 3');
      r.spin('Обработано 1 из 3'); // same frame -> no-op
      expect(text(r)).toBe('Обработано 1 из 3\n');
    });

    it('spin prints a changed frame on a new line', () => {
      const r = renderer(false);
      r.spin('Обработано 1 из 3');
      r.spin('Обработано 2 из 3 · Обрабатывается: A');
      expect(text(r)).toBe(
        'Обработано 1 из 3\nОбработано 2 из 3 · Обрабатывается: A\n',
      );
    });

    it('clear is a no-op in non-TTY mode', () => {
      const r = renderer(false);
      r.spin('x');
      const before = r.chunks.length;
      r.clear();
      expect(r.chunks.length).toBe(before);
    });

    it('static prints the line directly with a newline (no clear)', () => {
      const r = renderer(false);
      r.spin('progress');
      r.static('Wrote 1 repo(s) to out.json');
      expect(text(r)).toBe(
        'progress\nWrote 1 repo(s) to out.json\n',
      );
    });

    it('finish behaves like static in non-TTY mode', () => {
      const r = renderer(false);
      r.spin('progress');
      r.finish('Обработано 3 из 3');
      expect(text(r)).toBe('progress\nОбработано 3 из 3\n');
    });

    it('end is a no-op', () => {
      const r = renderer(false);
      r.end();
      expect(r.chunks).toHaveLength(0);
    });

    it('tty getter reflects mode', () => {
      expect(renderer(false).tty).toBe(false);
    });
  });

  it('works against the real stderr (integration)', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const p = new ProgressRenderer(false);
    p.spin('Обработано 0 из 2');
    p.static('ok');
    expect(spy).toHaveBeenCalled();
  });
});
