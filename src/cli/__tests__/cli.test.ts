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
}));

vi.mock('../../config/load.ts', () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock('../../commands/find-strings.ts', () => ({
  findStrings: mocks.findStrings,
}));

vi.mock('node:fs/promises', () => ({
  writeFile: mocks.writeFile,
}));

import { buildProgram, runCli, runFindStrings } from '../../cli.ts';

const collectWriteCalls = (spy: ReturnType<typeof vi.spyOn>): string =>
  spy.mock.calls.map((c) => String(c[0])).join('');

// Reusable default config shape for mocked loadConfig().
const defaultConfig = () => ({
  gitlab: { url: 'https://gitlab.example.com' },
  defaults: {
    branch: 'develop',
    excludeRepos: [],
    includeTests: false,
  },
  commands: {
    'find-strings': { concurrency: 5 },
  },
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

  describe('runtime error handling', () => {
    it('catches loadConfig errors, prints to stderr, and exits 1', async () => {
      mocks.loadConfig.mockRejectedValue(new Error('Config not found'));

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
      expect(stderrText).toContain('Error: Config not found');
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
});
