import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Hoisted cosmiconfig mock. `vi.hoisted` runs BEFORE `vi.mock`, so
 * `searchMock` is created first and the mock factory captures it via closure.
 * This must stay at the top of the file — `vi.mock` is hoisted by Vitest
 * to run before any imports.
 */
const { searchMock } = vi.hoisted(() => ({
  searchMock: vi.fn(),
}));

vi.mock('cosmiconfig', () => ({
  cosmiconfig: vi.fn(() => ({ search: searchMock })),
}));

import { loadConfig } from '../load.ts';

describe('loadConfig', () => {
  beforeEach(() => {
    searchMock.mockReset();
  });

  describe('missing config', () => {
    // Post-refactor: `loadConfig()` does NOT throw when no config file is
    // found. It returns a fully defaulted config with `gitlab: undefined`,
    // letting the CLI layer (`resolveOptions` in `src/cli.ts`) handle the
    // missing-required error reporting with a single consolidated message.

    it('returns fully defaulted config when search returns null', async () => {
      searchMock.mockResolvedValue(null);

      const config = await loadConfig();

      expect(config.gitlab).toBeUndefined();
      expect(config.defaults.branch).toBe('develop');
      expect(config.defaults.excludeRepos).toEqual([]);
      expect(config.defaults.includeTests).toBe(false);
      expect(config.defaults.enableLogs).toBe(false);
      expect(config.commands['find-matches'].concurrency).toBe(5);
    });

    it('returns fully defaulted config when search returns isEmpty: true', async () => {
      searchMock.mockResolvedValue({
        config: undefined,
        isEmpty: true,
        filepath: '',
      } as never);

      const config = await loadConfig();

      expect(config.gitlab).toBeUndefined();
      expect(config.defaults.branch).toBe('develop');
      expect(config.commands['find-matches'].concurrency).toBe(5);
    });
  });

  describe('valid config', () => {
    it('parses a minimal valid config and applies all defaults', async () => {
      searchMock.mockResolvedValue({
        config: { gitlab: { url: 'https://gitlab.example.com' } },
        isEmpty: false,
        filepath: '/cwd/gitlab-analyzer.json',
      } as never);

      const config = await loadConfig();

      expect(config.gitlab?.url).toBe('https://gitlab.example.com');
      expect(config.defaults.branch).toBe('develop');
      expect(config.defaults.excludeRepos).toEqual([]);
      expect(config.commands['find-matches'].concurrency).toBe(5);
    });

    it('accepts a config with no gitlab block (url will come from env)', async () => {
      searchMock.mockResolvedValue({
        config: { defaults: { branch: 'main' } },
        isEmpty: false,
        filepath: '/cwd/gitlab-analyzer.json',
      } as never);

      const config = await loadConfig();

      expect(config.gitlab).toBeUndefined();
      expect(config.defaults.branch).toBe('main');
    });

    it('preserves user-provided fields without modification', async () => {
      searchMock.mockResolvedValue({
        config: {
          gitlab: { url: 'https://gitlab.example.com' },
          defaults: {
            branch: 'main',
            excludeRepos: ['archived'],
            includeTests: true,
          },
          commands: {
            'find-matches': {
              concurrency: 10,
              output: './out.json',
            },
          },
        },
        isEmpty: false,
        filepath: '/cwd/gitlab-analyzer.json',
      } as never);

      const config = await loadConfig();

      expect(config.defaults.branch).toBe('main');
      expect(config.defaults.excludeRepos).toEqual(['archived']);
      expect(config.defaults.includeTests).toBe(true);
      expect(config.commands['find-matches'].concurrency).toBe(10);
      expect(config.commands['find-matches'].output).toBe('./out.json');
    });

    it('preserves user-provided enableLogs: true', async () => {
      searchMock.mockResolvedValue({
        config: {
          gitlab: { url: 'https://gitlab.example.com' },
          defaults: { enableLogs: true },
        },
        isEmpty: false,
        filepath: '/cwd/gitlab-analyzer.json',
      } as never);

      const config = await loadConfig();

      expect(config.defaults.enableLogs).toBe(true);
    });
  });

  describe('zod error propagation', () => {
    // The schema still rejects user-authored configs that are structurally
    // wrong — those are real bugs the user must fix, not "defaults
    // silently applied" situations.

    it('propagates zod error when gitlab.token is present (security gate)', async () => {
      searchMock.mockResolvedValue({
        config: {
          gitlab: {
            url: 'https://gitlab.example.com',
            token: 'PLACEHOLDER_TOKEN_VALUE',
          },
        },
        isEmpty: false,
        filepath: '/cwd/gitlab-analyzer.json',
      } as never);

      await expect(loadConfig()).rejects.toThrow(/Unrecognized key|token/i);
    });

    it('propagates zod error when gitlab.url is not a URL', async () => {
      searchMock.mockResolvedValue({
        config: { gitlab: { url: 'not-a-url' } },
        isEmpty: false,
        filepath: '/cwd/gitlab-analyzer.json',
      } as never);

      await expect(loadConfig()).rejects.toThrow(/url|Invalid/i);
    });

    it('accepts {gitlab: {}} — empty gitlab block is valid (url defers to env)', async () => {
      // Post-refactor: an explicit `gitlab: {}` is fine. The CLI will
      // report the missing URL via `resolveOptions` if neither env nor
      // config provides one.
      searchMock.mockResolvedValue({
        config: { gitlab: {} },
        isEmpty: false,
        filepath: '/cwd/gitlab-analyzer.json',
      } as never);

      const config = await loadConfig();

      expect(config.gitlab?.url).toBeUndefined();
    });
  });
});
