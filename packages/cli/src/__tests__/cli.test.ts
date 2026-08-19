import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommanderError } from 'commander';
import path from 'node:path';
import os from 'node:os';

// Mock variables captured by vi.mock factories below. Hoisted by Vitest
// to before the imports so the factories can reference them safely.
const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  findMatches: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  repoSelect: vi.fn(),
  getAllProjects: vi.fn(),
  existsSync: vi.fn(),
}));

// cli.ts imports findMatches + loadConfig from `@gitlab-analyzer/core` (public)
// and getAllProjects from `@gitlab-analyzer/core/internal`. Mock only the
// network-facing functions; keep the rest of the real module (logger,
// configureLogger, axiosInstance, ProgressRenderer) so the progress/logger
// wiring assertions exercise the real implementations.
vi.mock('@gitlab-analyzer/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gitlab-analyzer/core')>();
  return {
    ...actual,
    findMatches: mocks.findMatches,
    loadConfig: mocks.loadConfig,
  };
});

vi.mock('@gitlab-analyzer/core/internal', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@gitlab-analyzer/core/internal')
  >();
  return {
    ...actual,
    getAllProjects: mocks.getAllProjects,
  };
});

vi.mock('node:fs/promises', () => ({
  writeFile: mocks.writeFile,
  mkdir: mocks.mkdir,
}));

vi.mock('node:fs', () => ({
  existsSync: mocks.existsSync,
}));

vi.mock('../utils/repo-select.ts', () => ({
  repoSelect: mocks.repoSelect,
  enquirerRepoSelect: vi.fn(),
}));

import { buildProgram, runCli } from '../cli.ts';

/**
 * Default env values for tests. Set in the file-level `beforeEach` below so
 * every test has GITLAB_URL and PRIVATE_TOKEN available unless it explicitly
 * opts out (e.g. to assert the "missing required" error path).
 */
const TEST_GITLAB_URL = 'https://gitlab.example.com';
const TEST_PRIVATE_TOKEN = 'test-token-for-vitest';

const collectWriteCalls = (spy: ReturnType<typeof vi.spyOn>): string =>
  spy.mock.calls.map((c: readonly unknown[]) => String(c[0])).join('');

// Reusable default config shape for mocked loadConfig().
const defaultConfig = () => ({
  defaults: {
    branch: 'develop',
    excludeRepos: [],
    fileInclude: [],
    fileExclude: [],
  },
  commands: {
    'find-matches': { concurrency: 5 },
  },
});

/**
 * File-level setup: make resolution happy for every test that does NOT
 * specifically exercise the missing-required error path.
 */
beforeEach(() => {
  process.env.GITLAB_URL = TEST_GITLAB_URL;
  process.env.PRIVATE_TOKEN = TEST_PRIVATE_TOKEN;
});

describe('cli > buildProgram', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      _code?: number | string | null,
    ) => {
      throw new Error(`process.exit(${String(_code)})`);
    }) as never);
    mocks.loadConfig.mockReset();
    mocks.findMatches.mockReset();
    mocks.writeFile.mockReset();
    mocks.mkdir.mockReset();
    mocks.repoSelect.mockReset();
    mocks.getAllProjects.mockReset();
    mocks.existsSync.mockReset();
    mocks.existsSync.mockReturnValue(false);
    mocks.getAllProjects.mockResolvedValue([
      { id: 1, name: 'alpha', description: null },
    ]);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  describe('--help on find-matches subcommand', () => {
    it('lists every option from PLAN Section5.1', async () => {
      const program = buildProgram();

      // buildProgram() enables exitOverride() by default, so --help throws
      // a CommanderError with code commander.helpDisplayed. Swallow it
      // here so we can assert on the captured stdout/stderr text.
      await program
        .parseAsync([
          'node',
          'gitlab-analyzer',
          'find-matches',
          '--help',
        ])
        .catch((e: unknown) => {
          if (e instanceof CommanderError) return;
          throw e;
        });

      const out = collectWriteCalls(stdoutSpy) + collectWriteCalls(stderrSpy);
      // All 7 subcommand options from Section5.1 must be documented.
      expect(out).toContain('--repo-filter');
      expect(out).toContain('--exclude');
      expect(out).toContain('--branch');
      expect(out).toContain('--file-include');
      expect(out).toContain('--file-exclude');
      expect(out).toContain('--output');
      expect(out).toContain('--concurrency');
      expect(out).toContain('--interactive');
      expect(out).toContain('--enable-logs');
      // Plus the positional argument and global --help.
      expect(out).toContain('<strings...>');
      expect(out).toContain('--help');
    });

    it('lists the subcommand name and a short description', async () => {
      const program = buildProgram();

      await program
        .parseAsync([
          'node',
          'gitlab-analyzer',
          'find-matches',
          '--help',
        ])
        .catch((e: unknown) => {
          if (e instanceof CommanderError) return;
          throw e;
        });

      const out = collectWriteCalls(stdoutSpy) + collectWriteCalls(stderrSpy);
      expect(out).toContain('find-matches');
      expect(out).toMatch(/search/i);
    });
  });

  describe('parse errors', () => {
    it('throws CommanderError with code commander.unknownOption for unknown flags', async () => {
      const program = buildProgram();

      const caught = await program
        .parseAsync([
          'node',
          'gitlab-analyzer',
          'find-matches',
          '--definitely-not-a-real-flag',
        ])
        .catch((e: unknown) => e);

      expect(caught).toBeInstanceOf(CommanderError);
      expect((caught as CommanderError).code).toBe('commander.unknownOption');
    });

    it('throws CommanderError when the required <strings...> argument is missing', async () => {
      const program = buildProgram();

      const caught = await program
        .parseAsync(['node', 'gitlab-analyzer', 'find-matches'])
        .catch((e: unknown) => e);

      expect(caught).toBeInstanceOf(CommanderError);
      expect((caught as CommanderError).code).toBe('commander.missingArgument');
    });
  });

  describe('end-to-end mocked run', () => {
    it('writes a JSON file at --output containing the mocked results', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());

      mocks.findMatches.mockImplementation(async (opts) => {
        opts.onProgress?.(1, 1, 'mocked-repo');
        return [
          {
            projectId: 42,
            projectName: 'mocked-repo',
            projectDescription: 'fixture',
            resultsLength: 1,
            results: [
              {
                filename: '/src/foo.ts',
                matches: ['bar'],
                content: ['bar'],
              },
            ],
          },
        ];
      });

      mocks.writeFile.mockResolvedValue(undefined);

      const tmpFile = path.join(
        os.tmpdir(),
        `gitlab-analyzer-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      );

      const program = buildProgram();

      await program.parseAsync([
        'node',
        'gitlab-analyzer',
        'find-matches',
        'bar',
        '--output',
        tmpFile,
      ]);

      expect(mocks.writeFile).toHaveBeenCalledTimes(1);
      const [targetPath, payload, encoding] = mocks.writeFile.mock.calls[0];
      expect(targetPath).toBe(tmpFile);
      expect(encoding).toBe('utf-8');
      expect(String(payload)).toContain('"projectName": "mocked-repo"');
      expect(String(payload)).toContain('"projectId": 42');
      expect(String(payload)).toContain('"metadata"');
      expect(String(payload)).toContain('"repositories"');
    });

    it('reports progress to stderr via onProgress callback', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());

      mocks.findMatches.mockImplementation(async (opts) => {
        opts.onProgress?.(1, 3, 'first');
        opts.onProgress?.(2, 3, 'second');
        opts.onProgress?.(3, 3, 'third');
        return [];
      });

      mocks.writeFile.mockResolvedValue(undefined);

      const tmpFile = path.join(
        os.tmpdir(),
        `gitlab-analyzer-progress-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      );

      const program = buildProgram();

      await program.parseAsync([
        'node',
        'gitlab-analyzer',
        'find-matches',
        'needle',
        '--output',
        tmpFile,
      ]);

      const stderrText = collectWriteCalls(stderrSpy);
  expect(stderrText).toContain('Processed 1 of 3');
  expect(stderrText).toContain('Processed 2 of 3');
  expect(stderrText).toContain('Processed 3 of 3');
    });

    it('shows the last started repo name after the counter via onRepoStart', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());

      mocks.getAllProjects.mockResolvedValue([
        { id: 1, name: 'alpha', description: null },
        { id: 2, name: 'beta', description: null },
      ]);

      mocks.findMatches.mockImplementation(async (opts) => {
        opts.onRepoStart?.('alpha');
        opts.onProgress?.(1, 2, 'alpha');
        opts.onRepoStart?.('beta');
        opts.onProgress?.(2, 2, 'beta');
        return [];
      });

      mocks.writeFile.mockResolvedValue(undefined);

      const tmpFile = path.join(
        os.tmpdir(),
        `gitlab-analyzer-progress-start-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      );

      const program = buildProgram();

      await program.parseAsync([
        'node',
        'gitlab-analyzer',
        'find-matches',
        'needle',
        '--output',
        tmpFile,
      ]);

      const stderrText = collectWriteCalls(stderrSpy);
      expect(stderrText).toContain('Processed 0 of 2 · alpha');
      expect(stderrText).toContain('Processed 1 of 2 · alpha');
      expect(stderrText).toContain('Processed 1 of 2 · beta');
      expect(stderrText).toContain('Processed 2 of 2 · beta');
    });

    it('emits a summary line to stderr after a successful file write', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.getAllProjects.mockResolvedValue([
        { id: 1, name: 'alpha', description: null },
        { id: 2, name: 'beta', description: null },
      ]);
      mocks.findMatches.mockResolvedValue([
        {
          projectId: 1,
          projectName: 'alpha',
          projectDescription: null,
          resultsLength: 0,
          results: [],
        },
        {
          projectId: 2,
          projectName: 'beta',
          projectDescription: null,
          resultsLength: 0,
          results: [],
        },
      ]);
      mocks.writeFile.mockResolvedValue(undefined);

      const tmpFile = path.join(
        os.tmpdir(),
        `gitlab-analyzer-summary-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      );

      const program = buildProgram();
      await program.parseAsync([
        'node',
        'gitlab-analyzer',
        'find-matches',
        'x',
        '--output',
        tmpFile,
      ]);

      const stderrText = collectWriteCalls(stderrSpy);
  expect(stderrText).toContain('✓ Scanned repositories: 2');
  expect(stderrText).toContain(`✓ Report: ${tmpFile}`);
    });

    it('writes the report to stdout when --stdout is passed', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.findMatches.mockResolvedValue([
        {
          projectId: 7,
          projectName: 'stdout-repo',
          projectDescription: null,
          resultsLength: 0,
          results: [],
        },
      ]);
      mocks.writeFile.mockResolvedValue(undefined);

      const program = buildProgram();
      await program.parseAsync([
        'node',
        'gitlab-analyzer',
        'find-matches',
        'needle',
        '--stdout',
      ]);

      // With --stdout and no --output, an auto-named file is still written,
      // and the report is ALSO emitted to stdout.
      expect(mocks.writeFile).toHaveBeenCalledTimes(1);
      const stdoutText = collectWriteCalls(stdoutSpy);
      expect(stdoutText).toContain('"projectName": "stdout-repo"');
      expect(stdoutText).toContain('"metadata"');
    });

    it('parses comma-separated --exclude values into an array', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.findMatches.mockResolvedValue([]);
      mocks.writeFile.mockResolvedValue(undefined);

      const tmpFile = path.join(
        os.tmpdir(),
        `gitlab-analyzer-exclude-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      );

      const program = buildProgram();

      await program.parseAsync([
        'node',
        'gitlab-analyzer',
        'find-matches',
        'needle',
        '--exclude',
        'wip, archive , ,old',
        '--output',
        tmpFile,
      ]);

      expect(mocks.findMatches).toHaveBeenCalledTimes(1);
      const passedOpts = mocks.findMatches.mock.calls[0][0];
      expect(passedOpts.excludeRepos).toEqual(['wip', 'archive', 'old']);
    });

    it('parses comma-separated --file-include values into an array', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.findMatches.mockResolvedValue([]);
      mocks.writeFile.mockResolvedValue(undefined);

      const program = buildProgram();

      await program.parseAsync([
        'node',
        'gitlab-analyzer',
        'find-matches',
        'needle',
        '--file-include',
        '**/*.ts, **/*.tsx , ,src/**/*.json',
      ]);

      expect(mocks.findMatches).toHaveBeenCalledTimes(1);
      const passedOpts = mocks.findMatches.mock.calls[0][0];
      expect(passedOpts.fileInclude).toEqual([
        '**/*.ts',
        '**/*.tsx',
        'src/**/*.json',
      ]);
    });

    it('parses comma-separated --file-exclude values into an array', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.findMatches.mockResolvedValue([]);
      mocks.writeFile.mockResolvedValue(undefined);

      const program = buildProgram();

      await program.parseAsync([
        'node',
        'gitlab-analyzer',
        'find-matches',
        'needle',
        '--file-exclude',
        'dist/**, **/*.test.ts , ,node_modules/**',
      ]);

      expect(mocks.findMatches).toHaveBeenCalledTimes(1);
      const passedOpts = mocks.findMatches.mock.calls[0][0];
      expect(passedOpts.fileExclude).toEqual([
        'dist/**',
        '**/*.test.ts',
        'node_modules/**',
      ]);
    });

    it('last-wins for repeated --file-include (replace, not merge)', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.findMatches.mockResolvedValue([]);
      mocks.writeFile.mockResolvedValue(undefined);

      const program = buildProgram();

      await program.parseAsync([
        'node',
        'gitlab-analyzer',
        'find-matches',
        'needle',
        '--file-include',
        'first/**/*.ts',
        '--file-include',
        'second/**/*.json',
      ]);

      expect(mocks.findMatches).toHaveBeenCalledTimes(1);
      const passedOpts = mocks.findMatches.mock.calls[0][0];
      expect(passedOpts.fileInclude).toEqual(['second/**/*.json']);
    });
  });

  describe('runtime error handling', () => {
    it('catches missing-required errors from resolveOptions, prints to stderr, and exits 1', async () => {
      delete process.env.GITLAB_URL;
      delete process.env.PRIVATE_TOKEN;
      mocks.loadConfig.mockResolvedValue({
        defaults: {
          branch: 'develop',
          excludeRepos: [],
          fileInclude: [],
          fileExclude: [],
        },
        commands: { 'find-matches': { concurrency: 5 } },
      });

      const program = buildProgram();

      await program
        .parseAsync([
          'node',
          'gitlab-analyzer',
          'find-matches',
          'needle',
        ])
        .catch((e: unknown) => {
          // action handler calls process.exit(1) — exitSpy converts that to a
          // thrown Error('process.exit(1)'). Catch so the test does not fail.
          if (e instanceof Error && e.message === 'process.exit(1)') return;
          throw e;
        });

      const stderrText = collectWriteCalls(stderrSpy);
      // Error header from the action handler.
      expect(stderrText).toMatch(/Error: Cannot run find-matches/);
      // Consolidated list — every missing field appears in ONE error.
      expect(stderrText).toContain('gitlabUrl');
      expect(stderrText).toContain('PRIVATE_TOKEN');
      expect(stderrText).toContain('GITLAB_URL');
      expect(stderrText).toContain('Set PRIVATE_TOKEN');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});

describe('cli > runCli', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      _code?: number | string | null,
    ) => {
      throw new Error(`process.exit(${String(_code)})`);
    }) as never);
    mocks.loadConfig.mockReset();
    mocks.findMatches.mockReset();
    mocks.writeFile.mockReset();
    mocks.mkdir.mockReset();
    mocks.repoSelect.mockReset();
    mocks.getAllProjects.mockReset();
    mocks.getAllProjects.mockResolvedValue([
      { id: 1, name: 'alpha', description: null },
    ]);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('returns normally on --help (no exit)', async () => {
    await expect(
      runCli(['node', 'gitlab-analyzer', '--help']),
    ).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('returns normally on find-matches --help', async () => {
    await expect(
      runCli(['node', 'gitlab-analyzer', 'find-matches', '--help']),
    ).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('returns normally on --version', async () => {
    await expect(
      runCli(['node', 'gitlab-analyzer', '--version']),
    ).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits with code 2 on commander usage errors', async () => {
    await expect(
      runCli([
        'node',
        'gitlab-analyzer',
        'find-matches',
        '--definitely-not-a-real-flag',
      ]),
    ).rejects.toThrow('process.exit(2)');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('exits with code 2 when required <strings...> argument is missing', async () => {
    await expect(
      runCli(['node', 'gitlab-analyzer', 'find-matches']),
    ).rejects.toThrow('process.exit(2)');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('exits with code 1 on unexpected runtime errors', async () => {
    mocks.loadConfig.mockRejectedValue(new Error('boom'));

    await expect(
      runCli(['node', 'gitlab-analyzer', 'find-matches', 'x']),
    ).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const stderrText = collectWriteCalls(stderrSpy);
    expect(stderrText).toContain('Error: boom');
  });
});
