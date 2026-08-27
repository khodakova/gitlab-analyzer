import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  findMatches: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  repoSelect: vi.fn(),
  getAllProjects: vi.fn(),
  existsSync: vi.fn(),
}));

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

vi.mock('../../utils/repo-select.ts', () => ({
  repoSelect: mocks.repoSelect,
  enquirerRepoSelect: vi.fn(),
}));

import { runFindMatches } from '../find-matches.ts';
import * as loggerModule from '@gitlab-analyzer/core';
import { axiosInstance } from '@gitlab-analyzer/core/internal';

const TEST_GITLAB_URL = 'https://gitlab.example.com';
const TEST_PRIVATE_TOKEN = 'test-token-for-vitest';

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

const collectWriteCalls = (spy: ReturnType<typeof vi.spyOn>): string =>
  spy.mock.calls.map((c: readonly unknown[]) => String(c[0])).join('');

beforeEach(() => {
  process.env.GITLAB_URL = TEST_GITLAB_URL;
  process.env.PRIVATE_TOKEN = TEST_PRIVATE_TOKEN;
});

describe('runFindMatches (exported helper)', () => {
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
    mocks.findMatches.mockReset();
    mocks.writeFile.mockReset();
    mocks.mkdir.mockReset();
    mocks.repoSelect.mockReset();
    mocks.getAllProjects.mockReset();
    mocks.existsSync.mockReset();
    mocks.existsSync.mockReturnValue(false);
    // Default to one project so normal headless scans get past the 0-repo
    // guard; tests that exercise the empty case set `[]` explicitly.
    mocks.getAllProjects.mockResolvedValue([
      { id: 1, name: 'alpha', description: null },
    ]);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  describe('axiosInstance token/URL propagation from CLI flags', () => {
    it('sets axiosInstance PRIVATE-TOKEN header from --private-token', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.findMatches.mockResolvedValue([]);
      mocks.writeFile.mockResolvedValue(undefined);

      await runFindMatches(['needle'], { privateToken: 'cli-token' });

      expect(axiosInstance.defaults.headers['PRIVATE-TOKEN']).toBe('cli-token');
    });

    it('sets axiosInstance baseURL from --gitlab-url', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.findMatches.mockResolvedValue([]);
      mocks.writeFile.mockResolvedValue(undefined);

      await runFindMatches(['needle'], { gitlabUrl: 'https://cli.example.com' });

      expect(axiosInstance.defaults.baseURL).toBe('https://cli.example.com');
    });

    it('uses the env token when no --private-token flag is passed', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.findMatches.mockResolvedValue([]);
      mocks.writeFile.mockResolvedValue(undefined);

      await runFindMatches(['needle'], {});

      expect(axiosInstance.defaults.headers['PRIVATE-TOKEN']).toBe(TEST_PRIVATE_TOKEN);
    });
  });

  it('merges CLI options with config defaults and forwards to findMatches', async () => {
    mocks.loadConfig.mockResolvedValue({
      gitlab: { url: 'https://gitlab.example.com' },
      defaults: {
        branch: 'main',
        excludeRepos: ['archive'],
        fileInclude: [],
        fileExclude: [],
      },
      commands: { 'find-matches': { concurrency: 10 } },
    });

    mocks.findMatches.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);

    const result = await runFindMatches(['needle'], {
      branch: 'develop', // CLI override
      repoFilter: 'frontend',
      exclude: ['wip'], // CLI override
      fileInclude: ['**/*.ts'],
      fileExclude: ['**/*.test.ts'],
      concurrency: 3, // CLI override
    });

    // One scanned repo (default mock) with zero matches is still reported.
    expect(result.report.repositories).toHaveLength(1);
    expect(result.report.repositories[0]).toMatchObject({
      projectName: 'alpha',
      resultsLength: 0,
      error: null,
    });
    // No --output → an auto-named file is generated (not stdout).
    expect(result.outputPath).toMatch(/^find-matches-results-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    const [autoPath, payload] = mocks.writeFile.mock.calls[0];
    expect(autoPath).toBe(result.outputPath);
    // The report payload is the new JSON object shape with metadata.
    expect(String(payload)).toContain('"metadata"');
    expect(String(payload)).toContain('"repositories"');

    expect(mocks.findMatches).toHaveBeenCalledTimes(1);
    expect(mocks.findMatches).toHaveBeenCalledWith(
      expect.objectContaining({
        searchStrings: ['needle'],
        branch: 'develop', // CLI wins over config
        repoNameFilter: 'frontend',
        excludeRepos: ['wip'], // CLI wins over config
        fileInclude: ['**/*.ts'],
        fileExclude: ['**/*.test.ts'],
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
        fileInclude: ['**/app/**'],
        fileExclude: [],
      },
      commands: { 'find-matches': { concurrency: 7 } },
    });

    mocks.findMatches.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);

    await runFindMatches(['x'], {});

    expect(mocks.findMatches).toHaveBeenCalledTimes(1);
    expect(mocks.findMatches).toHaveBeenCalledWith(
      expect.objectContaining({
        searchStrings: ['x'],
        branch: 'develop',
        repoNameFilter: 'backend',
        excludeRepos: ['skip-me'],
        fileInclude: ['**/app/**'],
        fileExclude: [],
        concurrency: 7,
      }),
    );
  });

  it('forwards empty fileInclude/fileExclude as [] when both CLI and config are silent', async () => {
    mocks.loadConfig.mockResolvedValue({
      gitlab: { url: 'https://gitlab.example.com' },
      defaults: {},
      commands: { 'find-matches': {} },
    });

    mocks.findMatches.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);

    await runFindMatches(['x'], {});

    expect(mocks.findMatches).toHaveBeenCalledTimes(1);
    expect(mocks.findMatches).toHaveBeenCalledWith(
      expect.objectContaining({
        searchStrings: ['x'],
        fileInclude: [],
        fileExclude: [],
      }),
    );
  });

  it('uses commands.find-matches.output as fallback when --output is omitted', async () => {
    mocks.loadConfig.mockResolvedValue({
      gitlab: { url: 'https://gitlab.example.com' },
      defaults: {
        branch: 'develop',
        excludeRepos: [],
        fileInclude: [],
        fileExclude: [],
      },
      commands: {
        'find-matches': {
          concurrency: 5,
          output: '/tmp/from-config.json',
        },
      },
    });
    mocks.findMatches.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);

    const result = await runFindMatches(['x'], {});

    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile.mock.calls[0][0]).toBe('/tmp/from-config.json');
    expect(result.outputPath).toBe('/tmp/from-config.json');
  });

  it('creates the parent directory of --output recursively before writing', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.findMatches.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.mkdir.mockResolvedValue(undefined);

    const nestedDir = path.join(
      os.tmpdir(),
      `gitlab-analyzer-mkdir-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      'level2',
    );
    const outputPath = path.join(nestedDir, 'result.json');

    const result = await runFindMatches(['x'], { output: outputPath });

    expect(mocks.mkdir).toHaveBeenCalledTimes(1);
    expect(mocks.mkdir).toHaveBeenCalledWith(path.dirname(outputPath), {
      recursive: true,
    });

    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile.mock.calls[0][0]).toBe(outputPath);
    expect(result.outputPath).toBe(outputPath);
  });

  it('writes an auto-named file when --output is omitted', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.findMatches.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);

    const result = await runFindMatches(['x'], {});

    expect(mocks.mkdir).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(result.outputPath).toMatch(/^find-matches-results-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
  });

  it('prints the resolved repo list to stderr in headless mode', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.getAllProjects.mockResolvedValue([
      { id: 1, name: 'alpha', description: null },
      { id: 2, name: 'beta', description: null },
      { id: 3, name: 'skip', description: null },
    ]);
    mocks.findMatches.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);

    const result = await runFindMatches(['x'], {});

    const stderrText = collectWriteCalls(stderrSpy);
    expect(stderrText).toContain('Search will run across 3 repositories:');
    expect(stderrText).toContain('alpha');
    expect(stderrText).toContain('beta');
    expect(stderrText).toContain('skip');
    expect(result.outputPath).toMatch(/find-matches-results-\d{4}-\d{2}-\d{2}-\d{4}\.json/);
  });

  it('shows a loader while the repository list is being fetched', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.findMatches.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.mkdir.mockResolvedValue(undefined);

    let resolveProjects!: (v: unknown) => void;
    mocks.getAllProjects.mockReturnValue(
      new Promise((resolve) => {
        resolveProjects = resolve;
      }),
    );

    // The 0-repo headless guard calls process.exit(0); swallow it here.
    let exitSpy: ReturnType<typeof vi.spyOn>;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      _code?: number | string | null,
    ) => {
      throw new Error(`process.exit(${String(_code)})`);
    }) as never);

    vi.useFakeTimers();
    try {
      const runPromise = runFindMatches(['x'], {});

      await vi.advanceTimersByTimeAsync(150);

      const duringFetch = collectWriteCalls(stderrSpy);
      expect(duringFetch).toContain('Fetching repository list...');

      resolveProjects([]);
      await runPromise
        .then(() => {
          throw new Error('expected process.exit(0) to be called');
        })
        .catch((e: unknown) => {
          if (e instanceof Error && e.message === 'process.exit(0)') return;
          throw e;
        });

      expect(exitSpy).toHaveBeenCalledWith(0);
      const afterText = collectWriteCalls(stderrSpy);
      expect(afterText).toMatch(/no repositories|filter|exclus/i);
    } finally {
      vi.useRealTimers();
      exitSpy.mockRestore();
    }
  });

  it('passes the pre-filtered project list to findMatches (no duplicate fetch)', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.getAllProjects.mockResolvedValue([
      { id: 1, name: 'alpha', description: 'A' },
      { id: 2, name: 'beta', description: 'B' },
      { id: 3, name: 'skip', description: 'S' },
    ]);
    mocks.findMatches.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);

    await runFindMatches(['x'], { exclude: ['skip'] });

    expect(mocks.getAllProjects).toHaveBeenCalledTimes(1);

    expect(mocks.findMatches).toHaveBeenCalledTimes(1);
    const passedOpts = mocks.findMatches.mock.calls[0][0];
    expect(passedOpts.projects).toEqual([
      { id: 1, name: 'alpha', description: 'A' },
      { id: 2, name: 'beta', description: 'B' },
    ]);
  });

  it('enables the central logger when --interactive is set (logger wiring)', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.getAllProjects.mockResolvedValue([]);
    mocks.repoSelect.mockResolvedValue([{ id: 1, name: 'alpha' }]);
    mocks.findMatches.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);

    const configureSpy = vi
      .spyOn(loggerModule, 'configureLogger')
      .mockImplementation(() => {});

    await runFindMatches(['x'], { interactive: true });

    expect(configureSpy).toHaveBeenCalledWith({ enabled: true });
    configureSpy.mockRestore();
  });

  it('keeps the central logger disabled when neither --enable-logs nor --interactive', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.findMatches.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);

    const configureSpy = vi
      .spyOn(loggerModule, 'configureLogger')
      .mockImplementation(() => {});

    await runFindMatches(['x'], {});

    expect(configureSpy).toHaveBeenCalledWith({ enabled: false });
    configureSpy.mockRestore();
  });

  it('captures metadata, repositories and a per-repo error / branchExists=false', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.getAllProjects.mockResolvedValue([
      { id: 1, name: 'good', description: 'G' },
      { id: 2, name: 'badbranch', description: null },
    ]);
    mocks.findMatches.mockImplementation(async (opts) => {
      opts.onProgress?.(1, 2, 'good');
      opts.onProgress?.(
        2,
        2,
        'badbranch',
        'Request failed with status code 404',
      );
      return [
        {
          projectId: 1,
          projectName: 'good',
          projectDescription: 'G',
          resultsLength: 1,
          results: [
            {
              filename: '/src/a.ts',
              matches: ['needle'],
              content: ['needle'],
            },
          ],
        },
      ];
    });
    mocks.writeFile.mockResolvedValue(undefined);

    const result = await runFindMatches(['needle'], {
      format: 'json',
    });

    expect(result.report.metadata.searchStrings).toEqual(['needle']);
    expect(result.report.metadata.branch).toBe('develop');
    expect(result.report.metadata.generatedAt).toBeTruthy();

    const names = result.report.repositories.map((r) => r.projectName).sort();
    expect(names).toEqual(['badbranch', 'good']);

    const bad = result.report.repositories.find((r) => r.projectName === 'badbranch');
    expect(bad?.error).toContain('404');
    expect(bad?.branchExists).toBe(false);
    expect(bad?.results).toEqual([]);

    const good = result.report.repositories.find((r) => r.projectName === 'good');
    expect(good?.resultsLength).toBe(1);
    expect(good?.branchExists).toBe(true);
    expect(good?.error).toBeNull();
  });

  it('writes txt payload to the auto-named .txt file when --format txt', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.findMatches.mockResolvedValue([
      {
        projectId: 1,
        projectName: 'alpha',
        projectDescription: null,
        resultsLength: 1,
        results: [
          {
            filename: '/src/a.ts',
            matches: ['needle'],
            content: ['needle'],
          },
        ],
      },
    ]);
    mocks.writeFile.mockResolvedValue(undefined);

    const result = await runFindMatches(['needle'], { format: 'txt' });

    expect(result.outputPath).toMatch(/\.txt$/);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    const [path, payload] = mocks.writeFile.mock.calls[0];
    expect(String(path)).toMatch(/\.txt$/);
    expect(String(payload)).not.toContain('"metadata"');
    expect(String(payload)).toContain('Generated at:');
    expect(String(payload)).toContain('---- alpha (id: 1) ----');
  });

  it('does NOT call repoSelect (headless) when --interactive is absent', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.findMatches.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.repoSelect.mockResolvedValue([]);

    await runFindMatches(['needle'], {});

    expect(mocks.repoSelect).not.toHaveBeenCalled();
  });

  it('runs the picker and passes selectedRepos to findMatches when --interactive', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.findMatches.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.getAllProjects.mockResolvedValue([
      { id: 1, name: 'alpha', description: null },
      { id: 2, name: 'beta', description: null },
    ]);
    mocks.repoSelect.mockResolvedValue([
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
    ]);

    await runFindMatches(['needle'], { interactive: true });

    expect(mocks.repoSelect).toHaveBeenCalledTimes(1);
    expect(mocks.findMatches).toHaveBeenCalledTimes(1);
    const passedOpts = mocks.findMatches.mock.calls[0][0];
    expect(passedOpts.selectedRepos).toEqual([
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
    ]);
  });

  it('cancels (exit 0, no search, message to stderr) when the user selects nothing', async () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      _code?: number | string | null,
    ) => {
      throw new Error(`process.exit(${String(_code)})`);
    }) as never);

    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.findMatches.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.getAllProjects.mockResolvedValue([
      { id: 1, name: 'alpha', description: null },
    ]);
    mocks.repoSelect.mockResolvedValue([]);

    await runFindMatches(['needle'], { interactive: true })
      .then(() => {
        throw new Error('expected process.exit(0) to be called');
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.message === 'process.exit(0)') return;
        throw e;
      });

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(mocks.findMatches).not.toHaveBeenCalled();
    const stderrText = collectWriteCalls(stderrSpy);
    expect(stderrText).toMatch(/search|cancel|repositor|nothing/i);
    exitSpy.mockRestore();
  });

  it('stops early (exit 0, no search) when no repos match the filter', async () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      _code?: number | string | null,
    ) => {
      throw new Error(`process.exit(${String(_code)})`);
    }) as never);

    mocks.loadConfig.mockResolvedValue(defaultConfig());
    // No projects match the filter (explicit empty).
    mocks.getAllProjects.mockResolvedValue([]);
    mocks.findMatches.mockResolvedValue([]);

    await runFindMatches(['needle'], {})
      .then(() => {
        throw new Error('expected process.exit(0) to be called');
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.message === 'process.exit(0)') return;
        throw e;
      });

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(mocks.findMatches).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    const stderrText = collectWriteCalls(stderrSpy);
    expect(stderrText).toMatch(/no repositories|filter|exclus/i);
    // No misleading "searching 0 repos" phase or summary.
    expect(stderrText).not.toContain('Starting search across 0');
    expect(stderrText).not.toContain('Scanned repositories: 0');
    exitSpy.mockRestore();
  });

  it('logs info phases and a success completion to stderr (visible without --enable-logs)', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.getAllProjects.mockResolvedValue([
      { id: 1, name: 'alpha', description: null },
    ]);
    mocks.findMatches.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);

    await runFindMatches(['needle'], {});
    // Logger writes go through an async queue; drain it before asserting stderr.
    await loggerModule.flushLogs();

    const stderrText = collectWriteCalls(stderrSpy);
    expect(stderrText).toContain('ℹ Fetching repository list');
    expect(stderrText).toContain('Repository list fetched: 1');
    expect(stderrText).toContain('ℹ Starting search across 1 repositories');
    // success completion — always visible
    expect(stderrText).toContain('✓ Search finished.');
  });

  it('prints a summary block with ⚠ errored repos and the report path', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.getAllProjects.mockResolvedValue([
      { id: 1, name: 'good', description: null },
      { id: 2, name: 'bad', description: null },
    ]);
    mocks.findMatches.mockImplementation(async (opts) => {
      opts.onProgress?.(1, 2, 'good');
      opts.onProgress?.(2, 2, 'bad', 'boom');
      return [
        {
          projectId: 1,
          projectName: 'good',
          projectDescription: null,
          resultsLength: 1,
          results: [
            { filename: '/src/a.ts', matches: ['needle'], content: ['needle'] },
          ],
        },
      ];
    });
    mocks.writeFile.mockResolvedValue(undefined);

    await runFindMatches(['needle'], { output: '/tmp/out.json' });
    await loggerModule.flushLogs();

    const stderrText = collectWriteCalls(stderrSpy);
    expect(stderrText).toContain('✓ Scanned repositories: 2');
    expect(stderrText).toContain('⚠ Of which errored: 1 (bad)');
    expect(stderrText).toContain('✓ Report: /tmp/out.json');
    // blank separator line between the search output and the summary block
    expect(stderrText).toMatch(/\n\n\u001b\[32m✓ Scanned repositories: 2/);
  });

  describe('output-filter', () => {
    const setupRepos = () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      // good = has matches; empty = scanned, no matches; bad = errored.
      mocks.getAllProjects.mockResolvedValue([
        { id: 1, name: 'good', description: null },
        { id: 2, name: 'empty', description: null },
        { id: 3, name: 'bad', description: null },
      ]);
      mocks.findMatches.mockImplementation(async (opts) => {
        opts.onProgress?.(1, 3, 'good');
        opts.onProgress?.(2, 3, 'empty');
        opts.onProgress?.(3, 3, 'bad', 'boom');
        return [
          {
            projectId: 1,
            projectName: 'good',
            projectDescription: null,
            resultsLength: 1,
            results: [
              { filename: '/src/a.ts', matches: ['needle'], content: ['needle'] },
            ],
          },
        ];
      });
      mocks.writeFile.mockResolvedValue(undefined);
    };

    it('--output-filter found keeps only repos with matches (errors excluded)', async () => {
      setupRepos();
      const result = await runFindMatches(['needle'], { outputFilter: 'found' });
      const names = result.report.repositories.map((r) => r.projectName);
      expect(names).toEqual(['good']);
    });

    it('--output-filter not-found keeps only repos without matches (errors excluded)', async () => {
      setupRepos();
      const result = await runFindMatches(['needle'], { outputFilter: 'not-found' });
      const names = result.report.repositories.map((r) => r.projectName);
      expect(names).toEqual(['empty']);
    });

    it('default (all) keeps every scanned repo including errors', async () => {
      setupRepos();
      const result = await runFindMatches(['needle'], {});
      const names = result.report.repositories.map((r) => r.projectName).sort();
      expect(names).toEqual(['bad', 'empty', 'good']);
    });

    it('--output-filter all behaves like the default', async () => {
      setupRepos();
      const result = await runFindMatches(['needle'], { outputFilter: 'all' });
      const names = result.report.repositories.map((r) => r.projectName).sort();
      expect(names).toEqual(['bad', 'empty', 'good']);
    });

    it('writes an empty report + warning when no repo matches the filter', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      // Every scanned repo has no matches and no errors → 'found' yields nothing.
      mocks.getAllProjects.mockResolvedValue([
        { id: 2, name: 'empty', description: null },
      ]);
      mocks.findMatches.mockImplementation(async (opts) => {
        opts.onProgress?.(1, 1, 'empty');
        return [];
      });
      mocks.writeFile.mockResolvedValue(undefined);

      const result = await runFindMatches(['needle'], { outputFilter: 'found' });
      expect(result.report.repositories).toEqual([]);
      const stderrText = collectWriteCalls(stderrSpy);
      expect(stderrText).toMatch(/No repositories matched --output-filter found/);
      // The report file is still written (empty).
      expect(mocks.writeFile).toHaveBeenCalled();
    });

    it('applies the filter to --stdout payload as well', async () => {
      setupRepos();
      await runFindMatches(['needle'], { outputFilter: 'found', stdout: true });
      const stdoutText = collectWriteCalls(stdoutSpy);
      expect(stdoutText).toContain('good');
      expect(stdoutText).not.toContain('empty');
      expect(stdoutText).not.toContain('bad');
    });
  });

  describe('performance metrics (--metrics-file + stderr summary)', () => {
    it('prints a Metrics stderr summary line even without --metrics-file', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.findMatches.mockResolvedValue([]);
      mocks.writeFile.mockResolvedValue(undefined);

      await runFindMatches(['needle'], {});
      const stderrText = collectWriteCalls(stderrSpy);
      expect(stderrText).toContain('Metrics:');
    });

    it('writes NDJSON run/repo/summary to --metrics-file (summary last)', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.getAllProjects.mockResolvedValue([
        { id: 1, name: 'good', description: null },
        { id: 2, name: 'bad', description: null },
      ]);
      // Drive metrics through findMatches' own `opts.metrics` accumulator.
      mocks.findMatches.mockImplementation(async (opts) => {
        opts.metrics?.perRepo.push({
          projectId: 1, projectName: 'good', downloadMs: 10, unzipMs: 5, scanMs: 3,
          totalMs: 20, filesScanned: 2, filesMatched: 1, textLength: 100,
        });
        opts.metrics?.perRepo.push({
          projectId: 2, projectName: 'bad', downloadMs: 60000, unzipMs: 0, scanMs: 0,
          totalMs: 61000, filesScanned: 0, filesMatched: 0, textLength: 0, error: 'timeout',
        });
        opts.onProgress?.(1, 2, 'good');
        opts.onProgress?.(2, 2, 'bad', 'timeout');
        return [];
      });
      mocks.writeFile.mockResolvedValue(undefined);

      const metricsPath = path.join(os.tmpdir(), `metrics-${Date.now()}-${Math.random().toString(36).slice(2)}.ndjson`);
      await runFindMatches(['needle'], { metricsFile: metricsPath });

      const metricsCall = mocks.writeFile.mock.calls.find((c) => String(c[0]) === metricsPath);
      expect(metricsCall).toBeDefined();
      const content = String(metricsCall![1]);
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(4);
      expect(JSON.parse(lines[0]).t).toBe('run');
      expect(JSON.parse(lines[1]).t).toBe('repo');
      expect(JSON.parse(lines[2]).t).toBe('repo');
      // summary is the last line.
      expect(JSON.parse(lines[3]).t).toBe('summary');
      const summary = JSON.parse(lines[3]);
      expect(summary.exitReason).toBe('complete');
      expect(summary.repos).toBe(2);
      expect(summary.ok).toBe(1);
      expect(summary.errored).toBe(1);
      expect(summary.maxRepoName).toBe('bad');
      expect(summary.totalHeapGrowthBytes).toBeTypeOf('number');
      const repo2 = JSON.parse(lines[2]);
      expect(repo2.error).toBe('timeout');
    });

    it('does not create a metrics file when the flag is absent', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.findMatches.mockResolvedValue([]);
      mocks.writeFile.mockResolvedValue(undefined);

      await runFindMatches(['needle'], {});
      // Only the report write happens — no metrics file.
      expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    });

    it('warns (not fatal) when writing --metrics-file fails', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.findMatches.mockResolvedValue([]);
      mocks.writeFile.mockImplementation(async (p: unknown) => {
        if (String(p).includes('.ndjson')) throw new Error('disk full');
      });

      const metricsPath = path.join(os.tmpdir(), `metrics-${Date.now()}.ndjson`);
      const result = await runFindMatches(['needle'], { metricsFile: metricsPath });

      // Report still written, command succeeds (no throw).
      expect(result.report).toBeTruthy();
      expect(result.outputPath).toBeTruthy();
      await loggerModule.flushLogs();
      expect(collectWriteCalls(stderrSpy)).toContain('Failed to write metrics file (');
    });

    it('writes run+summary with exitReason=cancel on interactive empty selection', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((((_code?: number | string | null) => {
        throw new Error(`process.exit(${String(_code)})`);
      }) as never));
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.getAllProjects.mockResolvedValue([{ id: 1, name: 'alpha', description: null }]);
      mocks.repoSelect.mockResolvedValue([]);
      mocks.writeFile.mockResolvedValue(undefined);

      const metricsPath = path.join(os.tmpdir(), `metrics-cancel-${Date.now()}.ndjson`);
      await runFindMatches(['needle'], { interactive: true, metricsFile: metricsPath })
        .catch((e: unknown) => {
          if (e instanceof Error && e.message === 'process.exit(0)') return;
          throw e;
        });

      const metricsCall = mocks.writeFile.mock.calls.find((c) => String(c[0]) === metricsPath);
      expect(metricsCall).toBeDefined();
      const content = String(metricsCall![1]);
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).t).toBe('run');
      expect(JSON.parse(lines[0]).exitReason).toBe('cancel');
      expect(JSON.parse(lines[1]).t).toBe('summary');
      expect(JSON.parse(lines[1]).exitReason).toBe('cancel');
      exitSpy.mockRestore();
    });
  });
});
