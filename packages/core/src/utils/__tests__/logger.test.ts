import { describe, it, expect, vi, afterEach } from 'vitest';
import { configureLogger, logger } from '../logger.ts';

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
    it('starts disabled — debug is a no-op by default', () => {
      const spy = setupStderrSpy();
      logger.debug('hidden');
      expect(collect(spy)).not.toContain('hidden');
    });

    it('error is printed even when logs are disabled (default)', () => {
      const spy = setupStderrSpy();
      logger.error('boom');
      expect(collect(spy)).toContain('boom');
    });
  });

  describe('enabled', () => {
    it('prints debug output to stderr when enabled', () => {
      const spy = setupStderrSpy();
      configureLogger({ enabled: true });
      logger.debug('visible');
      expect(collect(spy)).toContain('visible');
    });

    it('still prints error output when enabled', () => {
      const spy = setupStderrSpy();
      configureLogger({ enabled: true });
      logger.error('fatal');
      expect(collect(spy)).toContain('fatal');
    });

    it('writes to stderr (not stdout)', () => {
      const stderrSpy = setupStderrSpy();
      const stdoutSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      configureLogger({ enabled: true });
      logger.debug('hello');
      logger.error('world');
      expect(collect(stderrSpy)).toContain('hello');
      expect(collect(stderrSpy)).toContain('world');
      expect(collect(stdoutSpy)).not.toContain('hello');
      expect(collect(stdoutSpy)).not.toContain('world');
    });

    it('appends a newline to each logged line', () => {
      const spy = setupStderrSpy();
      configureLogger({ enabled: true });
      logger.debug('line');
      const writes = spy.mock.calls.map((c: readonly unknown[]) => String(c[0]));
      expect(writes.some((w: string) => w === 'line\n')).toBe(true);
    });
  });

  describe('re-enabling / disabling', () => {
    it('re-disabling mutes debug again while error keeps printing', () => {
      const spy = setupStderrSpy();
      configureLogger({ enabled: true });
      logger.debug('a');
      configureLogger({ enabled: false });
      logger.debug('b');
      logger.error('c');
      const text = collect(spy);
      expect(text).toContain('a');
      expect(text).not.toContain('b');
      expect(text).toContain('c');
    });
  });
});
