import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveFetchFilesOptions } from '../options.ts';

const TEST_GITLAB_URL = 'https://gitlab.example.com';
const TEST_PRIVATE_TOKEN = 'test-token-for-vitest';

/**
 * Minimal valid config for happy-path tests. `fetch-files` reads only
 * `config.defaults.*` (there is no `commands.fetch-files` config block).
 */
const emptyConfig = () => ({
  defaults: {
    branch: 'develop',
    excludeRepos: [],
    fileExclude: [],
    enableLogs: false,
  },
});

beforeEach(() => {
  process.env.GITLAB_URL = TEST_GITLAB_URL;
  process.env.PRIVATE_TOKEN = TEST_PRIVATE_TOKEN;
});

describe('resolveFetchFilesOptions (precedence: CLI > env > config > default)', () => {
  describe('precedence — CLI flag wins', () => {
    it('--branch overrides config.defaults.branch', () => {
      const config = {
        ...emptyConfig(),
        defaults: { ...emptyConfig().defaults, branch: 'main' },
      };

      const result = resolveFetchFilesOptions(
        ['**/*.ts'],
        { branch: 'develop' },
        config as never,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.branch).toBe('develop');
    });

    it('--repo-filter overrides config.defaults.repoNameFilter', () => {
      const config = {
        ...emptyConfig(),
        defaults: { ...emptyConfig().defaults, repoNameFilter: 'backend' },
      };

      const result = resolveFetchFilesOptions(
        ['**/*.ts'],
        { repoFilter: 'frontend' },
        config as never,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.repoNameFilter).toBe('frontend');
    });

    it('--file-exclude overrides config.defaults.fileExclude', () => {
      const config = {
        ...emptyConfig(),
        defaults: { ...emptyConfig().defaults, fileExclude: ['**/*.min.js'] },
      };

      const result = resolveFetchFilesOptions(
        ['**/*.ts'],
        { fileExclude: ['**/*.test.ts'] },
        config as never,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.fileExclude).toEqual(['**/*.test.ts']);
    });

    it('--exclude overrides config.defaults.excludeRepos verbatim (replace, NOT merge)', () => {
      const config = {
        ...emptyConfig(),
        defaults: { ...emptyConfig().defaults, excludeRepos: ['archived'] },
      };

      const result = resolveFetchFilesOptions(
        ['**/*.ts'],
        { exclude: ['wip'] },
        config as never,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.excludeRepos).toEqual(['wip']);
    });

    it('--concurrency overrides the built-in default', () => {
      const result = resolveFetchFilesOptions(
        ['**/*.ts'],
        { concurrency: 3 },
        emptyConfig() as never,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.concurrency).toBe(3);
    });
  });

  describe('precedence — config fills in when CLI is silent', () => {
    it('falls back to config.defaults.branch', () => {
      const config = {
        ...emptyConfig(),
        defaults: { ...emptyConfig().defaults, branch: 'main' },
      };

      const result = resolveFetchFilesOptions(['**/*.ts'], {}, config as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.branch).toBe('main');
    });

    it('falls back to config.defaults.excludeRepos', () => {
      const config = {
        ...emptyConfig(),
        defaults: {
          ...emptyConfig().defaults,
          excludeRepos: ['archived', 'wip'],
        },
      };

      const result = resolveFetchFilesOptions(['**/*.ts'], {}, config as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.excludeRepos).toEqual(['archived', 'wip']);
    });

    it('falls back to config.defaults.fileExclude', () => {
      const config = {
        ...emptyConfig(),
        defaults: { ...emptyConfig().defaults, fileExclude: ['**/*.test.ts'] },
      };

      const result = resolveFetchFilesOptions(['**/*.ts'], {}, config as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.fileExclude).toEqual(['**/*.test.ts']);
    });

    it('falls back to config.defaults.repoNameFilter', () => {
      const config = {
        ...emptyConfig(),
        defaults: { ...emptyConfig().defaults, repoNameFilter: 'backend' },
      };

      const result = resolveFetchFilesOptions(['**/*.ts'], {}, config as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.repoNameFilter).toBe('backend');
    });
  });

  describe('precedence — built-in default when nothing else', () => {
    it('branch defaults to "develop"', () => {
      const result = resolveFetchFilesOptions(['**/*.ts'], {}, emptyConfig() as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.branch).toBe('develop');
    });

    it('excludeRepos defaults to []', () => {
      const result = resolveFetchFilesOptions(['**/*.ts'], {}, emptyConfig() as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.excludeRepos).toEqual([]);
    });

    it('fileExclude defaults to []', () => {
      const result = resolveFetchFilesOptions(['**/*.ts'], {}, emptyConfig() as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.fileExclude).toEqual([]);
    });

    it('concurrency defaults to 5', () => {
      const result = resolveFetchFilesOptions(['**/*.ts'], {}, emptyConfig() as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.concurrency).toBe(5);
    });

    it('interactive defaults to false', () => {
      const result = resolveFetchFilesOptions(['**/*.ts'], {}, emptyConfig() as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.interactive).toBe(false);
    });

    it('repoNameFilter defaults to undefined', () => {
      const result = resolveFetchFilesOptions(['**/*.ts'], {}, emptyConfig() as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.repoNameFilter).toBeUndefined();
    });

    it('patterns are passed through verbatim', () => {
      const result = resolveFetchFilesOptions(
        ['**/*.ts', '**/*.md'],
        {},
        emptyConfig() as never,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.patterns).toEqual(['**/*.ts', '**/*.md']);
    });
  });

  describe('precedence — env > config for gitlabUrl', () => {
    it('GITLAB_URL env wins over config.gitlab.url', () => {
      process.env.GITLAB_URL = 'https://env-gitlab.example.com';

      const config = {
        ...emptyConfig(),
        gitlab: { url: 'https://config-gitlab.example.com' },
      };

      const result = resolveFetchFilesOptions(['**/*.ts'], {}, config as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.gitlabUrl).toBe('https://env-gitlab.example.com');
    });

    it('config.gitlab.url is used when GITLAB_URL env is unset', () => {
      delete process.env.GITLAB_URL;

      const config = {
        ...emptyConfig(),
        gitlab: { url: 'https://config-gitlab.example.com' },
      };

      const result = resolveFetchFilesOptions(['**/*.ts'], {}, config as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.gitlabUrl).toBe('https://config-gitlab.example.com');
    });
  });

  describe('precedence — CLI token/URL flags (--private-token / --gitlab-url)', () => {
    it('--private-token from CLI overrides PRIVATE_TOKEN env', () => {
      const result = resolveFetchFilesOptions(
        ['**/*.ts'],
        { privateToken: 'cli-token' },
        emptyConfig() as never,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.privateToken).toBe('cli-token');
    });

    it('--gitlab-url from CLI overrides GITLAB_URL env and config.gitlab.url', () => {
      const config = {
        ...emptyConfig(),
        gitlab: { url: 'https://config-gitlab.example.com' },
      };

      const result = resolveFetchFilesOptions(
        ['**/*.ts'],
        { gitlabUrl: 'https://cli.example.com' },
        config as never,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.gitlabUrl).toBe('https://cli.example.com');
    });

    it('empty --private-token "" falls back to PRIVATE_TOKEN env', () => {
      const result = resolveFetchFilesOptions(
        ['**/*.ts'],
        { privateToken: '' },
        emptyConfig() as never,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.privateToken).toBe(TEST_PRIVATE_TOKEN);
    });

    it('whitespace --private-token " " falls back to PRIVATE_TOKEN env', () => {
      const result = resolveFetchFilesOptions(
        ['**/*.ts'],
        { privateToken: '   ' },
        emptyConfig() as never,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.privateToken).toBe(TEST_PRIVATE_TOKEN);
    });

    it('trims whitespace around a non-empty CLI token', () => {
      const result = resolveFetchFilesOptions(
        ['**/*.ts'],
        { privateToken: '  padded-token  ' },
        emptyConfig() as never,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.privateToken).toBe('padded-token');
    });

    it('--private-token from CLI satisfies the required check when env is empty', () => {
      delete process.env.PRIVATE_TOKEN;

      const result = resolveFetchFilesOptions(
        ['**/*.ts'],
        { privateToken: 't' },
        emptyConfig() as never,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.privateToken).toBe('t');
    });

    it('--gitlab-url from CLI satisfies the required check when env and config are empty', () => {
      delete process.env.GITLAB_URL;

      const result = resolveFetchFilesOptions(
        ['**/*.ts'],
        { gitlabUrl: 'https://cli.example.com' },
        emptyConfig() as never,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.gitlabUrl).toBe('https://cli.example.com');
    });
  });

  describe('security — token is NEVER read from config', () => {
    it('a token smuggled into config does NOT satisfy PRIVATE_TOKEN', () => {
      delete process.env.PRIVATE_TOKEN;

      const config = {
        ...emptyConfig(),
        defaults: { ...emptyConfig().defaults, privateToken: 'config-token' },
      };

      const result = resolveFetchFilesOptions(['**/*.ts'], {}, config as never);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.map((e) => e.field)).toContain('PRIVATE_TOKEN');
      }
    });
  });

  describe('precedence — enableLogs (CLI > env > config > false)', () => {
    afterEach(() => {
      delete process.env.ENABLE_LOGS;
    });

    it('defaults to false when no source provides it', () => {
      delete process.env.ENABLE_LOGS;
      const result = resolveFetchFilesOptions(['**/*.ts'], {}, emptyConfig() as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.enableLogs).toBe(false);
    });

    it('reads ENABLE_LOGS=true from env when CLI and config are silent', () => {
      process.env.ENABLE_LOGS = 'true';
      const result = resolveFetchFilesOptions(['**/*.ts'], {}, emptyConfig() as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.enableLogs).toBe(true);
    });

    it('treats ENABLE_LOGS=1 as truthy', () => {
      process.env.ENABLE_LOGS = '1';
      const result = resolveFetchFilesOptions(['**/*.ts'], {}, emptyConfig() as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.enableLogs).toBe(true);
    });

    it('treats ENABLE_LOGS=false as falsy', () => {
      process.env.ENABLE_LOGS = 'false';
      const result = resolveFetchFilesOptions(['**/*.ts'], {}, emptyConfig() as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.enableLogs).toBe(false);
    });

    it('falls back to config.defaults.enableLogs when CLI/env are silent', () => {
      const config = {
        ...emptyConfig(),
        defaults: { ...emptyConfig().defaults, enableLogs: true },
      };

      const result = resolveFetchFilesOptions(['**/*.ts'], {}, config as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.enableLogs).toBe(true);
    });

    it('CLI flag enableLogs=true wins over env ENABLE_LOGS=false', () => {
      process.env.ENABLE_LOGS = 'false';
      const result = resolveFetchFilesOptions(
        ['**/*.ts'],
        { enableLogs: true },
        emptyConfig() as never,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.enableLogs).toBe(true);
    });

    it('CLI flag enableLogs=false wins over env ENABLE_LOGS=true', () => {
      process.env.ENABLE_LOGS = 'true';
      const result = resolveFetchFilesOptions(
        ['**/*.ts'],
        { enableLogs: false },
        emptyConfig() as never,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.enableLogs).toBe(false);
    });
  });

  describe('error collection — every missing field is reported in one shot', () => {
    it('reports gitlabUrl + PRIVATE_TOKEN + patterns when all three are missing', () => {
      delete process.env.GITLAB_URL;
      delete process.env.PRIVATE_TOKEN;

      const result = resolveFetchFilesOptions([], {}, emptyConfig() as never);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const fields = result.errors.map((e) => e.field);
        expect(fields).toEqual(
          expect.arrayContaining(['gitlabUrl', 'PRIVATE_TOKEN', 'patterns']),
        );
        // Each error carries actionable guidance.
        const gitlabErr = result.errors.find((e) => e.field === 'gitlabUrl');
        expect(gitlabErr?.message).toMatch(/GITLAB_URL|gitlab\.url/);
        const tokenErr = result.errors.find((e) => e.field === 'PRIVATE_TOKEN');
        expect(tokenErr?.message).toMatch(/PRIVATE_TOKEN/);
        const patternsErr = result.errors.find((e) => e.field === 'patterns');
        expect(patternsErr?.message).toMatch(/pattern/i);
      }
    });

    it('empty-array patterns fail with field "patterns"', () => {
      const result = resolveFetchFilesOptions([], {}, emptyConfig() as never);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.map((e) => e.field)).toContain('patterns');
    });

    it('all-empty-string patterns fail with field "patterns"', () => {
      const result = resolveFetchFilesOptions(
        ['', '   '],
        {},
        emptyConfig() as never,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.map((e) => e.field)).toContain('patterns');
    });

    it('one non-empty pattern among empties is enough', () => {
      const result = resolveFetchFilesOptions(
        ['', '**/*.ts'],
        {},
        emptyConfig() as never,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.patterns).toEqual(['', '**/*.ts']);
    });

    it('does NOT include fields that ARE satisfied', () => {
      delete process.env.GITLAB_URL;
      delete process.env.PRIVATE_TOKEN;
      // Satisfy patterns but leave the others missing.
      const result = resolveFetchFilesOptions(['**/*.ts'], {}, emptyConfig() as never);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const fields = result.errors.map((e) => e.field);
        expect(fields).not.toContain('patterns');
        expect(fields).toEqual(
          expect.arrayContaining(['gitlabUrl', 'PRIVATE_TOKEN']),
        );
      }
    });

    it('returns ok:true when all required fields are present', () => {
      // File-level beforeEach already sets GITLAB_URL + PRIVATE_TOKEN.
      const result = resolveFetchFilesOptions(['**/*.ts'], {}, emptyConfig() as never);

      expect(result.ok).toBe(true);
    });
  });

  describe('format (CLI-only, default "json")', () => {
    it('defaults to json', () => {
      const res = resolveFetchFilesOptions(['**/*.ts'], {}, emptyConfig() as never);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.resolved.format).toBe('json');
    });

    it('honors --format ndjson from CLI', () => {
      const res = resolveFetchFilesOptions(
        ['**/*.ts'],
        { format: 'ndjson' },
        emptyConfig() as never,
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.resolved.format).toBe('ndjson');
    });

    it('honors --format txt from CLI', () => {
      const res = resolveFetchFilesOptions(
        ['**/*.ts'],
        { format: 'txt' },
        emptyConfig() as never,
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.resolved.format).toBe('txt');
    });
  });

  describe('output & metricsFile (CLI flag only)', () => {
    it('output resolves from the CLI flag', () => {
      const res = resolveFetchFilesOptions(
        ['**/*.ts'],
        { output: './reports' },
        emptyConfig() as never,
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.resolved.output).toBe('./reports');
    });

    it('metricsFile defaults to undefined when the CLI flag is absent', () => {
      const res = resolveFetchFilesOptions(['**/*.ts'], {}, emptyConfig() as never);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.resolved.metricsFile).toBeUndefined();
    });

    it('metricsFile resolves from the CLI flag only (not config)', () => {
      const res = resolveFetchFilesOptions(
        ['**/*.ts'],
        { metricsFile: './m.ndjson' },
        emptyConfig() as never,
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.resolved.metricsFile).toBe('./m.ndjson');
    });
  });

  describe('interactive (CLI-only, default false)', () => {
    it('honors --interactive from CLI', () => {
      const res = resolveFetchFilesOptions(
        ['**/*.ts'],
        { interactive: true },
        emptyConfig() as never,
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.resolved.interactive).toBe(true);
    });
  });
});
