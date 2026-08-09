import { describe, it, expect } from 'vitest';
import { GitlabAnalyzerConfigSchema } from '../schema.ts';

describe('GitlabAnalyzerConfigSchema', () => {
  describe('minimal valid config', () => {
    it('parses {gitlab: {url}} and applies all defaults', () => {
      const parsed = GitlabAnalyzerConfigSchema.parse({
        gitlab: { url: 'https://gitlab.com' },
      });

      expect(parsed.gitlab.url).toBe('https://gitlab.com');
      expect(parsed.defaults.branch).toBe('develop');
      expect(parsed.defaults.excludeRepos).toEqual([]);
      expect(parsed.defaults.includeTests).toBe(false);
      expect(parsed.commands['find-strings'].concurrency).toBe(5);
      expect(parsed.commands['find-strings'].output).toBeUndefined();
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
    it('rejects missing gitlab.url', () => {
      expect(() =>
        GitlabAnalyzerConfigSchema.parse({
          gitlab: {},
        }),
      ).toThrow(/url|Required/i);
    });

    it('rejects missing gitlab object entirely', () => {
      expect(() => GitlabAnalyzerConfigSchema.parse({})).toThrow(/gitlab|Required/i);
    });

    it('rejects non-URL gitlab.url', () => {
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

    it('applies commands.find-strings.concurrency default = 5', () => {
      const parsed = GitlabAnalyzerConfigSchema.parse({
        gitlab: { url: 'https://gitlab.com' },
      });

      expect(parsed.commands['find-strings'].concurrency).toBe(5);
    });

    it('preserves user-provided concurrency', () => {
      const parsed = GitlabAnalyzerConfigSchema.parse({
        gitlab: { url: 'https://gitlab.com' },
        commands: { 'find-strings': { concurrency: 10 } },
      });

      expect(parsed.commands['find-strings'].concurrency).toBe(10);
    });

    it('applies inner FindStringsCommandSchema default when commands.find-strings key is missing', () => {
      // Covers schema-level default on line 30: 'find-strings' is undefined
      // (NOT just individual fields missing — those use field-level defaults).
      const parsed = GitlabAnalyzerConfigSchema.parse({
        gitlab: { url: 'https://gitlab.com' },
        commands: {}, // 'find-strings' key absent entirely
      });

      expect(parsed.commands['find-strings'].concurrency).toBe(5);
    });

    it('applies field-level concurrency default when only output is provided', () => {
      // Field-level default on line 18 (concurrency: z.number().int().positive().default(5))
      const parsed = GitlabAnalyzerConfigSchema.parse({
        gitlab: { url: 'https://gitlab.com' },
        commands: { 'find-strings': { output: './out.json' } },
      });

      expect(parsed.commands['find-strings'].concurrency).toBe(5);
      expect(parsed.commands['find-strings'].output).toBe('./out.json');
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
        },
        commands: {
          'find-strings': {
            concurrency: 5,
            output: './find-strings-result.json',
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
        },
        commands: {
          'find-strings': {
            concurrency: 5,
            output: './find-strings-result.json',
          },
        },
      });
    });
  });
});
