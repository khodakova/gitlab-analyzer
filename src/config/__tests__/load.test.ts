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
    it('throws clear error when search returns null', async () => {
      searchMock.mockResolvedValue(null);

      await expect(loadConfig()).rejects.toThrow(/No configuration found/);
    });

    it('throws clear error when search returns isEmpty: true', async () => {
      searchMock.mockResolvedValue({
        config: undefined,
        isEmpty: true,
        filepath: '',
      } as never);

      await expect(loadConfig()).rejects.toThrow(/No configuration found/);
    });

    it('error message tells user where to create the config', async () => {
      searchMock.mockResolvedValue(null);

      await expect(loadConfig()).rejects.toThrow(
        /gitlab-analyzer\.json|~\/\.config\/gitlab-analyzer/,
      );
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

      expect(config.gitlab.url).toBe('https://gitlab.example.com');
      expect(config.defaults.branch).toBe('develop');
      expect(config.defaults.excludeRepos).toEqual([]);
      expect(config.commands['find-strings'].concurrency).toBe(5);
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
            'find-strings': {
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
      expect(config.commands['find-strings'].concurrency).toBe(10);
      expect(config.commands['find-strings'].output).toBe('./out.json');
    });
  });

  describe('zod error propagation', () => {
    it('propagates zod error when gitlab.url is missing', async () => {
      searchMock.mockResolvedValue({
        config: { gitlab: {} },
        isEmpty: false,
        filepath: '/cwd/gitlab-analyzer.json',
      } as never);

      await expect(loadConfig()).rejects.toThrow(/url|Required/i);
    });

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
  });
});
