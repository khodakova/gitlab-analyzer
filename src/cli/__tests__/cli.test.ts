import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommanderError } from 'commander';
import path from 'node:path';
import os from 'node:os';

// Mock variables captured by vi.mock factories below. Hoisted by Vitest
// to before the imports so the factories can reference them safely.
const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  findStrings: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  repoSelect: vi.fn(),
  getAllProjects: vi.fn(),
}));

vi.mock('../../config/load.ts', () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock('../../commands/find-strings.ts', () => ({
  findStrings: mocks.findStrings,
}));

vi.mock('node:fs/promises', () => ({
  writeFile: mocks.writeFile,
  mkdir: mocks.mkdir,
}));

vi.mock('../../utils/repo-select.ts', () => ({
  repoSelect: mocks.repoSelect,
  enquirerRepoSelect: vi.fn(),
}));

vi.mock('../../utils/get-projects.ts', () => ({
  getAllProjects: mocks.getAllProjects,
}));

import { buildProgram, runCli, runFindStrings, resolveOptions } from '../../cli.ts';
import * as loggerModule from '../../utils/logger.ts';

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
// Note: post-refactor, `gitlab` is optional тАФ the loader no longer requires
// it (URL comes from GITLAB_URL env in real runs, set up in the file-level
// beforeEach below). Tests that exercise config-file-driven resolution pass
// a config with `gitlab` populated; tests of the missing-required path omit it.
const defaultConfig = () => ({
  defaults: {
    branch: 'develop',
    excludeRepos: [],
    includeTests: false,
  },
  commands: {
    'find-strings': { concurrency: 5 },
  },
});

/**
 * File-level setup: make `resolveOptions` happy for every test that does
 * NOT specifically exercise the missing-required error path. Tests that
 * want to assert on missing fields must `delete process.env.GITLAB_URL`
 * (and/or PRIVATE_TOKEN) inside the test body or its local beforeEach.
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
    mocks.findStrings.mockReset();
    mocks.writeFile.mockReset();
    mocks.mkdir.mockReset();
    mocks.repoSelect.mockReset();
    mocks.getAllProjects.mockReset();
    // runFindStrings now fetches the project list to build the repo report /
    // picker. Default to an empty list; interactive & headless-list tests
    // override this with their own fixtures.
    mocks.getAllProjects.mockResolvedValue([]);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  describe('--help on find-strings subcommand', () => {
    it('lists every option from PLAN Section5.1', async () => {
      const program = buildProgram();

      // buildProgram() enables exitOverride() by default, so --help throws
      // a CommanderError with code commander.helpDisplayed. Swallow it
      // here so we can assert on the captured stdout/stderr text.
      await program
        .parseAsync([
          'node',
          'gitlab-analyzer',
          'find-strings',
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
      expect(out).toContain('--path-filter');
      expect(out).toContain('--include-tests');
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
          'find-strings',
          '--help',
        ])
        .catch((e: unknown) => {
          if (e instanceof CommanderError) return;
          throw e;
        });

      const out = collectWriteCalls(stdoutSpy) + collectWriteCalls(stderrSpy);
      expect(out).toContain('find-strings');
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
          'find-strings',
          '--definitely-not-a-real-flag',
        ])
        .catch((e: unknown) => e);

      expect(caught).toBeInstanceOf(CommanderError);
      expect((caught as CommanderError).code).toBe('commander.unknownOption');
    });

    it('throws CommanderError when the required <strings...> argument is missing', async () => {
      const program = buildProgram();

      const caught = await program
        .parseAsync(['node', 'gitlab-analyzer', 'find-strings'])
        .catch((e: unknown) => e);

      expect(caught).toBeInstanceOf(CommanderError);
      // commander uses commander.missingArgument for variadic required args.
      expect((caught as CommanderError).code).toBe('commander.missingArgument');
    });
  });

  describe('end-to-end mocked run', () => {
    it('writes a JSON file at --output containing the mocked results', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());

      mocks.findStrings.mockImplementation(async (opts) => {
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
        'find-strings',
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
    });

    it('reports progress to stderr via onProgress callback', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());

      mocks.findStrings.mockImplementation(async (opts) => {
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
        'find-strings',
        'needle',
        '--output',
        tmpFile,
      ]);

      const stderrText = collectWriteCalls(stderrSpy);
      expect(stderrText).toContain('[1/3] first');
      expect(stderrText).toContain('[2/3] second');
      expect(stderrText).toContain('[3/3] third');
    });

    it('emits a summary line to stderr after a successful file write', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.findStrings.mockResolvedValue([
        {
          projectId: 1,
          projectName: 'a',
          projectDescription: null,
          resultsLength: 0,
          results: [],
        },
        {
          projectId: 2,
          projectName: 'b',
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
        'find-strings',
        'x',
        '--output',
        tmpFile,
      ]);

      const stderrText = collectWriteCalls(stderrSpy);
      expect(stderrText).toContain(`Wrote 2 result(s) to ${tmpFile}`);
    });

    it('writes JSON to stdout when --output is omitted', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.findStrings.mockResolvedValue([
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
        'find-strings',
        'needle',
      ]);

      expect(mocks.writeFile).not.toHaveBeenCalled();
      const stdoutText = collectWriteCalls(stdoutSpy);
      expect(stdoutText).toContain('"projectName": "stdout-repo"');
    });

    it('parses comma-separated --exclude values into an array', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.findStrings.mockResolvedValue([]);
      mocks.writeFile.mockResolvedValue(undefined);

      const tmpFile = path.join(
        os.tmpdir(),
        `gitlab-analyzer-exclude-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      );

      const program = buildProgram();

      await program.parseAsync([
        'node',
        'gitlab-analyzer',
        'find-strings',
        'needle',
        '--exclude',
        'wip, archive , ,old',
        '--output',
        tmpFile,
      ]);

      expect(mocks.findStrings).toHaveBeenCalledTimes(1);
      const passedOpts = mocks.findStrings.mock.calls[0][0];
      expect(passedOpts.excludeRepos).toEqual(['wip', 'archive', 'old']);
    });
  });

  describe('--interactive with repo selection', () => {
    it('does NOT call repoSelect (headless) when --interactive is absent', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.findStrings.mockResolvedValue([]);
      mocks.writeFile.mockResolvedValue(undefined);
      mocks.getAllProjects.mockResolvedValue([]);
      mocks.repoSelect.mockResolvedValue([]);

      const program = buildProgram();
      await program.parseAsync([
        'node', 'gitlab-analyzer', 'find-strings', 'needle',
        '--output', path.join(os.tmpdir(), 'headless.json'),
      ]);

      expect(mocks.repoSelect).not.toHaveBeenCalled();
    });

    it('runs the picker and passes selectedRepos to findStrings when --interactive', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.findStrings.mockResolvedValue([]);
      mocks.writeFile.mockResolvedValue(undefined);
      mocks.getAllProjects.mockResolvedValue([
        { id: 1, name: 'alpha', description: null },
        { id: 2, name: 'beta', description: null },
      ]);
      mocks.repoSelect.mockResolvedValue([
        { id: 1, name: 'alpha' },
        { id: 2, name: 'beta' },
      ]);

      const program = buildProgram();
      await program.parseAsync([
        'node', 'gitlab-analyzer', 'find-strings', 'needle', '--interactive',
        '--output', path.join(os.tmpdir(), 'interactive.json'),
      ]);

      expect(mocks.repoSelect).toHaveBeenCalledTimes(1);
      expect(mocks.findStrings).toHaveBeenCalledTimes(1);
      const passedOpts = mocks.findStrings.mock.calls[0][0];
      expect(passedOpts.selectedRepos).toEqual([
        { id: 1, name: 'alpha' },
        { id: 2, name: 'beta' },
      ]);
    });

    it('cancels (exit 0, no search, message to stderr) when the user selects nothing', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.findStrings.mockResolvedValue([]);
      mocks.writeFile.mockResolvedValue(undefined);
      mocks.getAllProjects.mockResolvedValue([
        { id: 1, name: 'alpha', description: null },
      ]);
      mocks.repoSelect.mockResolvedValue([]);

      // Drive runFindStrings directly (as the action handler does) so we can
      // assert on process.exit(0) without the action-handler catch re-wrapping
      // the mocked exit into a generic runtime error (exit 1).
      await runFindStrings(['needle'], { interactive: true })
        .then(() => {
          throw new Error('expected process.exit(0) to be called');
        })
        .catch((e: unknown) => {
          if (e instanceof Error && e.message === 'process.exit(0)') return;
          throw e;
        });

      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(mocks.findStrings).not.toHaveBeenCalled();
      const stderrText = collectWriteCalls(stderrSpy);
      expect(stderrText).toMatch(/поиск|репозитори|cancel|отмен|ничего/i);
    });
  });

  describe('runtime error handling', () => {
    it('catches missing-required errors from resolveOptions, prints to stderr, and exits 1', async () => {
      // Post-refactor: loadConfig() no longer rejects on missing config
      // (it returns a defaulted object). The action handler now catches
      // errors thrown by `resolveOptions` when both env vars and config
      // fail to provide gitlabUrl / PRIVATE_TOKEN. The error message
      // contains a consolidated list of every missing field.
      delete process.env.GITLAB_URL;
      delete process.env.PRIVATE_TOKEN;
      mocks.loadConfig.mockResolvedValue({
        defaults: {
          branch: 'develop',
          excludeRepos: [],
          includeTests: false,
        },
        commands: { 'find-strings': { concurrency: 5 } },
      });

      const program = buildProgram();

      await program
        .parseAsync([
          'node',
          'gitlab-analyzer',
          'find-strings',
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
      expect(stderrText).toMatch(/Error: Cannot run find-strings/);
      // Consolidated list тАФ every missing field appears in ONE error.
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
    mocks.findStrings.mockReset();
    mocks.writeFile.mockReset();
    mocks.mkdir.mockReset();
    mocks.repoSelect.mockReset();
    mocks.getAllProjects.mockReset();
    // runFindStrings now fetches the project list to build the repo report /
    // picker. Default to an empty list; interactive & headless-list tests
    // override this with their own fixtures.
    mocks.getAllProjects.mockResolvedValue([]);
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

  it('returns normally on find-strings --help', async () => {
    await expect(
      runCli(['node', 'gitlab-analyzer', 'find-strings', '--help']),
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
        'find-strings',
        '--definitely-not-a-real-flag',
      ]),
    ).rejects.toThrow('process.exit(2)');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('exits with code 2 when required <strings...> argument is missing', async () => {
    await expect(
      runCli(['node', 'gitlab-analyzer', 'find-strings']),
    ).rejects.toThrow('process.exit(2)');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('exits with code 1 on unexpected runtime errors', async () => {
    mocks.loadConfig.mockRejectedValue(new Error('boom'));

    await expect(
      runCli(['node', 'gitlab-analyzer', 'find-strings', 'x']),
    ).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    // The error from loadConfig surfaces as "Error: boom" (from the action
    // handler's catch) — not "Fatal: boom", because runCli's catch only
    // runs on errors that escape parseAsync itself.
    const stderrText = collectWriteCalls(stderrSpy);
    expect(stderrText).toContain('Error: boom');
  });
});

describe('cli > runFindStrings (exported helper)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    mocks.loadConfig.mockReset();
    mocks.findStrings.mockReset();
    mocks.writeFile.mockReset();
    mocks.mkdir.mockReset();
    mocks.repoSelect.mockReset();
    mocks.getAllProjects.mockReset();
    // runFindStrings now fetches the project list to build the repo report /
    // picker. Default to an empty list; interactive & headless-list tests
    // override this with their own fixtures.
    mocks.getAllProjects.mockResolvedValue([]);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('merges CLI options with config defaults and forwards to findStrings', async () => {
    mocks.loadConfig.mockResolvedValue({
      gitlab: { url: 'https://gitlab.example.com' },
      defaults: {
        branch: 'main',
        excludeRepos: ['archive'],
        includeTests: false,
      },
      commands: { 'find-strings': { concurrency: 10 } },
    });

    mocks.findStrings.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);

    const result = await runFindStrings(['needle'], {
      branch: 'develop', // CLI override
      repoFilter: 'frontend',
      exclude: ['wip'], // CLI override
      pathFilter: '/lib/',
      includeTests: true,
      concurrency: 3, // CLI override
    });

    expect(result.results).toEqual([]);
    expect(result.outputPath).toBeUndefined();

    expect(mocks.findStrings).toHaveBeenCalledTimes(1);
    expect(mocks.findStrings).toHaveBeenCalledWith(
      expect.objectContaining({
        searchStrings: ['needle'],
        branch: 'develop', // CLI wins over config
        repoNameFilter: 'frontend',
        excludeRepos: ['wip'], // CLI wins over config
        pathFilter: '/lib/',
        includeTests: true,
        concurrency: 3, // CLI wins over config (10)
      }),
    );
  });

  it('falls back to config values when CLI options are omitted', async () => {
    mocks.loadConfig.mockResolvedValue({
      gitlab: { url: 'https://gitlab.example.com' },
      defaults: {
        branch: 'develop',
        repoNameFilter: 'backend',
        excludeRepos: ['skip-me'],
        pathFilter: '/app/',
        includeTests: false,
      },
      commands: { 'find-strings': { concurrency: 7 } },
    });

    mocks.findStrings.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);

    await runFindStrings(['x'], {});

    expect(mocks.findStrings).toHaveBeenCalledTimes(1);
    expect(mocks.findStrings).toHaveBeenCalledWith(
      expect.objectContaining({
        searchStrings: ['x'],
        branch: 'develop',
        repoNameFilter: 'backend',
        excludeRepos: ['skip-me'],
        pathFilter: '/app/',
        includeTests: false,
        concurrency: 7,
      }),
    );
  });

  it('uses commands.find-strings.output as fallback when --output is omitted', async () => {
    mocks.loadConfig.mockResolvedValue({
      gitlab: { url: 'https://gitlab.example.com' },
      defaults: {
        branch: 'develop',
        excludeRepos: [],
        includeTests: false,
      },
      commands: {
        'find-strings': {
          concurrency: 5,
          output: '/tmp/from-config.json',
        },
      },
    });
    mocks.findStrings.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);

    const result = await runFindStrings(['x'], {});

    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile.mock.calls[0][0]).toBe('/tmp/from-config.json');
    expect(result.outputPath).toBe('/tmp/from-config.json');
  });

  it('creates the parent directory of --output recursively before writing', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.findStrings.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.mkdir.mockResolvedValue(undefined);

    // Nested output path whose intermediate directories don't exist yet.
    // We use tmpdir() as the anchor so the test stays hermetic regardless
    // of cwd, but everything below it is unique to this run and will be
    // removed by `os.tmpdir()` cleanup eventually.
    const nestedDir = path.join(
      os.tmpdir(),
      `gitlab-analyzer-mkdir-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      'level2',
    );
    const outputPath = path.join(nestedDir, 'result.json');

    const result = await runFindStrings(['x'], { output: outputPath });

    // mkdir must be called exactly once, with the parent dir of outputPath
    // and recursive:true so any missing intermediate levels are created too.
    expect(mocks.mkdir).toHaveBeenCalledTimes(1);
    expect(mocks.mkdir).toHaveBeenCalledWith(path.dirname(outputPath), {
      recursive: true,
    });

    // writeFile still runs after mkdir, against the original output path.
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile.mock.calls[0][0]).toBe(outputPath);
    expect(result.outputPath).toBe(outputPath);
  });

  it('does not call mkdir when --output is omitted (stdout path)', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.findStrings.mockResolvedValue([]);

    const result = await runFindStrings(['x'], {});

    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(result.outputPath).toBeUndefined();
  });

    it('prints the resolved repo list to stderr in headless mode', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.getAllProjects.mockResolvedValue([
        { id: 1, name: 'alpha', description: null },
        { id: 2, name: 'beta', description: null },
        { id: 3, name: 'skip', description: null },
      ]);
      mocks.findStrings.mockResolvedValue([]);
      mocks.writeFile.mockResolvedValue(undefined);

      const result = await runFindStrings(['x'], {});

      const stderrText = collectWriteCalls(stderrSpy);
      expect(stderrText).toContain('Будет выполнен поиск по 3 репозиториям:');
      expect(stderrText).toContain('alpha');
      expect(stderrText).toContain('beta');
      expect(stderrText).toContain('skip');
      expect(result.outputPath).toBeUndefined();
    });

    it('passes the pre-filtered project list to findStrings (no duplicate fetch)', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.getAllProjects.mockResolvedValue([
        { id: 1, name: 'alpha', description: 'A' },
        { id: 2, name: 'beta', description: 'B' },
        { id: 3, name: 'skip', description: 'S' },
      ]);
      mocks.findStrings.mockResolvedValue([]);
      mocks.writeFile.mockResolvedValue(undefined);

      await runFindStrings(['x'], { exclude: ['skip'] });

      // getAllProjects is fetched exactly once (no duplicate list request).
      expect(mocks.getAllProjects).toHaveBeenCalledTimes(1);

      // findStrings receives `projects` = the full list minus excluded repos.
      expect(mocks.findStrings).toHaveBeenCalledTimes(1);
      const passedOpts = mocks.findStrings.mock.calls[0][0];
      expect(passedOpts.projects).toEqual([
        { id: 1, name: 'alpha', description: 'A' },
        { id: 2, name: 'beta', description: 'B' },
      ]);
    });

  it('enables the central logger when --interactive is set (logger wiring)', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.getAllProjects.mockResolvedValue([]);
    mocks.repoSelect.mockResolvedValue([{ id: 1, name: 'alpha' }]);
    mocks.findStrings.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);

    const configureSpy = vi
      .spyOn(loggerModule, 'configureLogger')
      .mockImplementation(() => {});

    await runFindStrings(['x'], { interactive: true });

    expect(configureSpy).toHaveBeenCalledWith({ enabled: true });
    configureSpy.mockRestore();
  });

  it('keeps the central logger disabled when neither --enable-logs nor --interactive', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.getAllProjects.mockResolvedValue([]);
    mocks.findStrings.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);

    const configureSpy = vi
      .spyOn(loggerModule, 'configureLogger')
      .mockImplementation(() => {});

    await runFindStrings(['x'], {});

    expect(configureSpy).toHaveBeenCalledWith({ enabled: false });
    configureSpy.mockRestore();
  });
});

describe('cli > resolveOptions (precedence: CLI > env > config > default)', () => {
  // The file-level beforeEach sets GITLAB_URL and PRIVATE_TOKEN. Tests in
  // this block mutate those values locally as needed.

  /** Minimal valid config for happy-path tests тАФ no gitlab block required. */
  const emptyConfig = () => ({
    defaults: {
      branch: 'develop',
      excludeRepos: [],
      includeTests: false,
    },
    commands: { 'find-strings': { concurrency: 5 } },
  });

  describe('precedence тАФ CLI flag wins', () => {
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

    it('--concurrency overrides config.commands.find-strings.concurrency', () => {
      const config = {
        ...emptyConfig(),
        commands: { 'find-strings': { concurrency: 10 } },
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

  describe('precedence тАФ config fills in when CLI is silent', () => {
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

  describe('precedence тАФ built-in default when nothing else', () => {
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

  describe('precedence тАФ env > config for gitlabUrl', () => {
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

  describe('error collection тАФ every missing field is reported in one shot', () => {
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
});
