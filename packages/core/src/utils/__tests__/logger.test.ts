import { describe, it, expect, vi, afterEach } from 'vitest';
import { configureLogger, logger, flushLogs } from '../logger.ts';

/**
 * Setup: spy on stderr so we can assert the logger writes there, and reset
 * the logger to its default (disabled) state between tests.
 */
function setupStderrSpy(): ReturnType<typeof vi.spyOn> {
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return spy;
}

const collect = (spy: ReturnType<typeof vi.spyOn>): string =>
  spy.mock.calls.map((c: readonly unknown[]) => String(c[0])).join('');

describe('logger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    configureLogger({ enabled: false });
  });

  describe('configureLogger default', () => {
    it('starts disabled — debug is a no-op by default', async () => {
      const spy = setupStderrSpy();
      logger.debug('hidden');
      await flushLogs();
      expect(collect(spy)).not.toContain('hidden');
    });

    it('error is printed even when logs are disabled (default)', async () => {
      const spy = setupStderrSpy();
      logger.error('boom');
      await flushLogs();
      expect(collect(spy)).toContain('boom');
    });
  });

  describe('enabled', () => {
    it('prints debug output to stderr when enabled', async () => {
      const spy = setupStderrSpy();
      configureLogger({ enabled: true });
      logger.debug('visible');
      await flushLogs();
      expect(collect(spy)).toContain('visible');
    });

    it('still prints error output when enabled', async () => {
      const spy = setupStderrSpy();
      configureLogger({ enabled: true });
      logger.error('fatal');
      await flushLogs();
      expect(collect(spy)).toContain('fatal');
    });

    it('writes to stderr (not stdout)', async () => {
      const stderrSpy = setupStderrSpy();
      const stdoutSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      configureLogger({ enabled: true });
      logger.debug('hello');
      logger.error('world');
      await flushLogs();
      expect(collect(stderrSpy)).toContain('hello');
      expect(collect(stderrSpy)).toContain('world');
      expect(collect(stdoutSpy)).not.toContain('hello');
      expect(collect(stdoutSpy)).not.toContain('world');
    });

    it('appends a newline to each logged line', async () => {
      const spy = setupStderrSpy();
      configureLogger({ enabled: true });
      logger.debug('line');
      await flushLogs();
      const writes = spy.mock.calls.map((c: readonly unknown[]) => String(c[0]));
      // The debug line gets a `[debug]` prefix (+ color codes) and a newline;
      // assert it contains the payload and terminates the write with `\n`.
      expect(writes.some((w: string) => w.includes('line') && w.endsWith('\n'))).toBe(true);
    });
  });

  describe('re-enabling / disabling', () => {
    it('re-disabling mutes debug again while error keeps printing', async () => {
      const spy = setupStderrSpy();
      configureLogger({ enabled: true });
      logger.debug('MARK_ONE');
      configureLogger({ enabled: false });
      logger.debug('MARK_TWO');
      logger.error('MARK_THREE');
      await flushLogs();
      const text = collect(spy);
      expect(text).toContain('[debug] MARK_ONE');
      expect(text).not.toContain('MARK_TWO');
      expect(text).toContain('✗ MARK_THREE');
    });
  });

  describe('levels', () => {
    it('logs debug with a [debug] prefix when enabled', async () => {
      const spy = setupStderrSpy();
      configureLogger({ enabled: true });
      logger.debug('dbg');
      await flushLogs();
      expect(collect(spy)).toContain('[debug]');
    });

    it('does NOT prefix debug when disabled (no write at all)', async () => {
      const spy = setupStderrSpy();
      logger.debug('dbg');
      await flushLogs();
      expect(collect(spy)).not.toContain('[debug]');
    });

    it('info / success / warn / error print ALWAYS (even when disabled)', async () => {
      const spy = setupStderrSpy();
      logger.info('i');
      logger.success('s');
      logger.warn('w');
      logger.error('e');
      await flushLogs();
      const text = collect(spy);
      expect(text).toContain('i');
      expect(text).toContain('s');
      expect(text).toContain('w');
      expect(text).toContain('e');
    });

    it('renders the level symbols (ℹ ✓ ⚠ ✗ [debug])', async () => {
      const spy = setupStderrSpy();
      configureLogger({ enabled: true });
      logger.debug('d');
      logger.info('i');
      logger.success('s');
      logger.warn('w');
      logger.error('e');
      await flushLogs();
      const text = collect(spy);
      expect(text).toContain('[debug]');
      expect(text).toContain('ℹ');
      expect(text).toContain('✓');
      expect(text).toContain('⚠');
      expect(text).toContain('✗');
    });
  });

  describe('write queue', () => {
    it('keeps many lines as separate writes without merging', async () => {
      const spy = setupStderrSpy();
      logger.info('one');
      logger.success('two');
      logger.warn('three');
      await flushLogs();
      const writes = spy.mock.calls.map((c: readonly unknown[]) => String(c[0]));
      expect(writes).toHaveLength(3);
      // Each written chunk is its own line (one write per log call).
      writes.forEach((w: string) => expect(w.endsWith('\n')).toBe(true));
    });

    it('flushLogs resolves after all scheduled writes complete', async () => {
      const spy = setupStderrSpy();
      logger.info('a');
      logger.warn('b');
      await flushLogs();
      expect(collect(spy)).toContain('a');
      expect(collect(spy)).toContain('b');
    });
  });
});
