import { describe, it, expect } from 'vitest';
import { GitlabAnalyzerConfigSchema } from '../schema.ts';

describe('GitlabAnalyzerConfigSchema', () => {
  describe('minimal valid config', () => {
    it('parses {gitlab: {url}} and applies all defaults', () => {
      const parsed = GitlabAnalyzerConfigSchema.parse({
        gitlab: { url: 'https://gitlab.com' },
      });

      expect(parsed.gitlab?.url).toBe('https://gitlab.com');
      expect(parsed.defaults.branch).toBe('develop');
      expect(parsed.defaults.excludeRepos).toEqual([]);
      expect(parsed.defaults.includeTests).toBe(false);
      expect(parsed.commands['find-matches'].concurrency).toBe(5);
      expect(parsed.commands['find-matches'].output).toBeUndefined();
    });

    it('parses empty {} and applies all defaults (url must come from env)', () => {
      // New behavior (post-precedence-refactor): a config file is OPTIONAL.
      // When missing or empty, the schema fills in defaults and leaves
      // `gitlab` undefined — the CLI then resolves `gitlabUrl` from
      // GITLAB_URL env (or errors out with a clear message).
      const parsed = GitlabAnalyzerConfigSchema.parse({});

      expect(parsed.gitlab).toBeUndefined();
      expect(parsed.defaults.branch).toBe('develop');
      expect(parsed.defaults.excludeRepos).toEqual([]);
      expect(parsed.defaults.includeTests).toBe(false);
      expect(parsed.commands['find-matches'].concurrency).toBe(5);
    });

    it('parses {gitlab: {}} with empty gitlab block (url deferred to env)', () => {
      const parsed = GitlabAnalyzerConfigSchema.parse({ gitlab: {} });

      expect(parsed.gitlab).toEqual({ url: undefined });
    });
  });

  describe('gitlab.token security gate', () => {
    it('rejects gitlab.token at any value (tokens must come from env only)', () => {
      expect(() =>
        GitlabAnalyzerConfigSchema.parse({
          gitlab: { url: 'https://gitlab.com', token: 'PLACEHOLDER_TOKEN_VALUE' },
        }),
      ).toThrow(/Unrecognized key|Unrecognized|token/i);
    });

    it('rejects unknown keys inside gitlab object (strict mode)', () => {
      expect(() =>
        GitlabAnalyzerConfigSchema.parse({
          gitlab: { url: 'https://gitlab.com', foo: 'bar' },
        }),
      ).toThrow(/Unrecognized key|Unrecognized/i);
    });
  });

  describe('required fields', () => {
    // NOTE: post-refactor, `gitlab` and `gitlab.url` are OPTIONAL in the
    // schema — runtime resolution prefers GITLAB_URL env over config, and
    // the CLI surfaces a clear "missing required" error when neither source
    // provides a URL. The schema only enforces *shape* correctness.

    it('rejects non-URL gitlab.url when one IS provided', () => {
      expect(() =>
        GitlabAnalyzerConfigSchema.parse({
          gitlab: { url: 'not-a-url' },
        }),
      ).toThrow(/url|Invalid|expected string/i);
    });
  });

  describe('defaults application', () => {
    it('applies DefaultsSchema defaults when defaults block is omitted', () => {
      const parsed = GitlabAnalyzerConfigSchema.parse({
        gitlab: { url: 'https://gitlab.com' },
      });

      expect(parsed.defaults).toEqual({
        branch: 'develop',
        excludeRepos: [],
        includeTests: false,
        enableLogs: false,
      });
    });

    it('preserves user-provided defaults while filling in omitted fields', () => {
      const parsed = GitlabAnalyzerConfigSchema.parse({
        gitlab: { url: 'https://gitlab.com' },
        defaults: {
          branch: 'main',
          excludeRepos: ['archived', 'wip'],
        },
      });

      expect(parsed.defaults.branch).toBe('main');
      expect(parsed.defaults.excludeRepos).toEqual(['archived', 'wip']);
      expect(parsed.defaults.includeTests).toBe(false);
    });

    it('defaults enableLogs to false when defaults block is omitted', () => {
      const parsed = GitlabAnalyzerConfigSchema.parse({});

      expect(parsed.defaults.enableLogs).toBe(false);
    });

    it('preserves user-provided enableLogs: true', () => {
      const parsed = GitlabAnalyzerConfigSchema.parse({
        gitlab: { url: 'https://gitlab.com' },
        defaults: { enableLogs: true },
      });

      expect(parsed.defaults.enableLogs).toBe(true);
    });

    it('applies commands.find-matches.concurrency default = 5', () => {
      const parsed = GitlabAnalyzerConfigSchema.parse({
        gitlab: { url: 'https://gitlab.com' },
      });

      expect(parsed.commands['find-matches'].concurrency).toBe(5);
    });

    it('preserves user-provided concurrency', () => {
      const parsed = GitlabAnalyzerConfigSchema.parse({
        gitlab: { url: 'https://gitlab.com' },
        commands: { 'find-matches': { concurrency: 10 } },
      });

      expect(parsed.commands['find-matches'].concurrency).toBe(10);
    });

    it('applies inner FindMatchesCommandSchema default when commands.find-matches key is missing', () => {
      // Covers schema-level default on line 30: 'find-matches' is undefined
      // (NOT just individual fields missing — those use field-level defaults).
      const parsed = GitlabAnalyzerConfigSchema.parse({
        gitlab: { url: 'https://gitlab.com' },
        commands: {}, // 'find-matches' key absent entirely
      });

      expect(parsed.commands['find-matches'].concurrency).toBe(5);
    });

    it('applies field-level concurrency default when only output is provided', () => {
      // Field-level default on line 18 (concurrency: z.number().int().positive().default(5))
      const parsed = GitlabAnalyzerConfigSchema.parse({
        gitlab: { url: 'https://gitlab.com' },
        commands: { 'find-matches': { output: './out.json' } },
      });

      expect(parsed.commands['find-matches'].concurrency).toBe(5);
      expect(parsed.commands['find-matches'].output).toBe('./out.json');
    });
  });

  describe('full round-trip', () => {
    it('parses a complete config with every supported field', () => {
      const config = {
        gitlab: { url: 'https://gitlab.example.com' },
        defaults: {
          branch: 'develop',
          repoNameFilter: 'frontend',
          excludeRepos: ['archived-repo', 'wip-repo'],
          pathFilter: '/src/',
          includeTests: false,
          enableLogs: true,
        },
        commands: {
          'find-matches': {
            concurrency: 5,
            output: './find-matches-result.json',
          },
        },
      };

      const parsed = GitlabAnalyzerConfigSchema.parse(config);

      expect(parsed).toEqual({
        gitlab: { url: 'https://gitlab.example.com' },
        defaults: {
          branch: 'develop',
          repoNameFilter: 'frontend',
          excludeRepos: ['archived-repo', 'wip-repo'],
          pathFilter: '/src/',
          includeTests: false,
          enableLogs: true,
        },
        commands: {
          'find-matches': {
            concurrency: 5,
            output: './find-matches-result.json',
          },
        },
      });
    });
  });
});
