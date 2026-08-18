import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveOptions } from '../options.ts';

const TEST_GITLAB_URL = 'https://gitlab.example.com';
const TEST_PRIVATE_TOKEN = 'test-token-for-vitest';

/** Minimal valid config for happy-path tests — no gitlab block required. */
const emptyConfig = () => ({
  defaults: {
    branch: 'develop',
    excludeRepos: [],
    includeTests: false,
  },
  commands: { 'find-matches': { concurrency: 5 } },
});

beforeEach(() => {
  process.env.GITLAB_URL = TEST_GITLAB_URL;
  process.env.PRIVATE_TOKEN = TEST_PRIVATE_TOKEN;
});

describe('resolveOptions (precedence: CLI > env > config > default)', () => {
  describe('precedence — CLI flag wins', () => {
    it('--branch overrides config.defaults.branch', () => {
      const config = {
        ...emptyConfig(),
        defaults: { ...emptyConfig().defaults, branch: 'main' },
      };

      const result = resolveOptions(['x'], { branch: 'develop' }, config as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.branch).toBe('develop');
    });

    it('--repo-filter overrides config.defaults.repoNameFilter', () => {
      const config = {
        ...emptyConfig(),
        defaults: { ...emptyConfig().defaults, repoNameFilter: 'backend' },
      };

      const result = resolveOptions(
        ['x'],
        { repoFilter: 'frontend' },
        config as never,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.repoNameFilter).toBe('frontend');
    });

    it('--include-tests overrides config.defaults.includeTests', () => {
      const config = {
        ...emptyConfig(),
        defaults: { ...emptyConfig().defaults, includeTests: true },
      };

      const result = resolveOptions(
        ['x'],
        { includeTests: false },
        config as never,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.includeTests).toBe(false);
    });

    it('--concurrency overrides config.commands.find-matches.concurrency', () => {
      const config = {
        ...emptyConfig(),
        commands: { 'find-matches': { concurrency: 10 } },
      };

      const result = resolveOptions(
        ['x'],
        { concurrency: 3 },
        config as never,
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.concurrency).toBe(3);
    });
  });

  describe('precedence — config fills in when CLI is silent', () => {
    it('falls back to config.defaults.branch = "main"', () => {
      const config = {
        ...emptyConfig(),
        defaults: { ...emptyConfig().defaults, branch: 'main' },
      };

      const result = resolveOptions(['x'], {}, config as never);

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

      const result = resolveOptions(['x'], {}, config as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.excludeRepos).toEqual(['archived', 'wip']);
    });
  });

  describe('precedence — built-in default when nothing else', () => {
    it('branch defaults to "develop"', () => {
      const result = resolveOptions(['x'], {}, emptyConfig() as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.branch).toBe('develop');
    });

    it('pathFilter defaults to "/src/"', () => {
      const result = resolveOptions(['x'], {}, emptyConfig() as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.pathFilter).toBe('/src/');
    });

    it('concurrency defaults to 5', () => {
      const result = resolveOptions(['x'], {}, emptyConfig() as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.concurrency).toBe(5);
    });

    it('excludeRepos defaults to []', () => {
      const result = resolveOptions(['x'], {}, emptyConfig() as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.excludeRepos).toEqual([]);
    });
  });

  describe('precedence — env > config for gitlabUrl', () => {
    it('GITLAB_URL env wins over config.gitlab.url', () => {
      process.env.GITLAB_URL = 'https://env-gitlab.example.com';

      const config = {
        ...emptyConfig(),
        gitlab: { url: 'https://config-gitlab.example.com' },
      };

      const result = resolveOptions(['x'], {}, config as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.gitlabUrl).toBe('https://env-gitlab.example.com');
    });

    it('config.gitlab.url is used when GITLAB_URL env is unset', () => {
      delete process.env.GITLAB_URL;

      const config = {
        ...emptyConfig(),
        gitlab: { url: 'https://config-gitlab.example.com' },
      };

      const result = resolveOptions(['x'], {}, config as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.gitlabUrl).toBe('https://config-gitlab.example.com');
    });
  });

  describe('precedence — enableLogs (CLI > env > config > false)', () => {
    afterEach(() => {
      delete process.env.ENABLE_LOGS;
    });

    it('defaults to false when no source provides it', () => {
      delete process.env.ENABLE_LOGS;
      const result = resolveOptions(['x'], {}, emptyConfig() as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.enableLogs).toBe(false);
    });

    it('reads ENABLE_LOGS=true from env when CLI and config are silent', () => {
      process.env.ENABLE_LOGS = 'true';
      const result = resolveOptions(['x'], {}, emptyConfig() as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.enableLogs).toBe(true);
    });

    it('treats ENABLE_LOGS=1 as truthy', () => {
      process.env.ENABLE_LOGS = '1';
      const result = resolveOptions(['x'], {}, emptyConfig() as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.enableLogs).toBe(true);
    });

    it('treats ENABLE_LOGS=false as falsy', () => {
      process.env.ENABLE_LOGS = 'false';
      const result = resolveOptions(['x'], {}, emptyConfig() as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.enableLogs).toBe(false);
    });

    it('falls back to config.defaults.enableLogs when CLI/env are silent', () => {
      const config = {
        ...emptyConfig(),
        defaults: { ...emptyConfig().defaults, enableLogs: true },
      };

      const result = resolveOptions(['x'], {}, config as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.enableLogs).toBe(true);
    });

    it('CLI flag --enable-logs wins over env ENABLE_LOGS=false', () => {
      process.env.ENABLE_LOGS = 'false';
      const result = resolveOptions(['x'], { enableLogs: true }, emptyConfig() as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.enableLogs).toBe(true);
    });

    it('CLI flag enableLogs=false wins over env ENABLE_LOGS=true', () => {
      process.env.ENABLE_LOGS = 'true';
      const result = resolveOptions(['x'], { enableLogs: false }, emptyConfig() as never);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolved.enableLogs).toBe(false);
    });
  });

  describe('error collection — every missing field is reported in one shot', () => {
    it('reports gitlabUrl + PRIVATE_TOKEN + strings when all three are missing', () => {
      delete process.env.GITLAB_URL;
      delete process.env.PRIVATE_TOKEN;

      const result = resolveOptions([], {}, emptyConfig() as never);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const fields = result.errors.map((e) => e.field);
        expect(fields).toEqual(
          expect.arrayContaining(['gitlabUrl', 'PRIVATE_TOKEN', 'strings']),
        );
        // Each error carries actionable guidance.
        const gitlabErr = result.errors.find((e) => e.field === 'gitlabUrl');
        expect(gitlabErr?.message).toMatch(/GITLAB_URL|gitlab\.url/);
        const tokenErr = result.errors.find((e) => e.field === 'PRIVATE_TOKEN');
        expect(tokenErr?.message).toMatch(/PRIVATE_TOKEN/);
      }
    });

    it('does NOT include fields that ARE satisfied', () => {
      delete process.env.GITLAB_URL;
      delete process.env.PRIVATE_TOKEN;
      // Satisfy strings but leave the others missing.
      const result = resolveOptions(['needle'], {}, emptyConfig() as never);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const fields = result.errors.map((e) => e.field);
        expect(fields).not.toContain('strings');
        expect(fields).toEqual(
          expect.arrayContaining(['gitlabUrl', 'PRIVATE_TOKEN']),
        );
      }
    });

    it('returns ok:true when all required fields are present', () => {
      // File-level beforeEach already sets GITLAB_URL + PRIVATE_TOKEN.
      const result = resolveOptions(['needle'], {}, emptyConfig() as never);

      expect(result.ok).toBe(true);
    });
  });

  describe('format & stdout', () => {
    it('defaults format to json and stdout to false', () => {
      const res = resolveOptions(['x'], {}, emptyConfig() as never);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.resolved.format).toBe('json');
        expect(res.resolved.stdout).toBe(false);
      }
    });

    it('honors --format and --stdout from CLI', () => {
      const res = resolveOptions(
        ['x'],
        { format: 'txt', stdout: true },
        emptyConfig() as never,
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.resolved.format).toBe('txt');
        expect(res.resolved.stdout).toBe(true);
      }
    });
  });

  describe('metricsFile', () => {
    it('defaults to undefined when the CLI flag is absent', () => {
      const res = resolveOptions(['x'], {}, emptyConfig() as never);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.resolved.metricsFile).toBeUndefined();
    });

    it('resolves from the CLI flag only (not config)', () => {
      const res = resolveOptions(
        ['x'],
        { metricsFile: './m.ndjson' },
        emptyConfig() as never,
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.resolved.metricsFile).toBe('./m.ndjson');
    });
  });
});
