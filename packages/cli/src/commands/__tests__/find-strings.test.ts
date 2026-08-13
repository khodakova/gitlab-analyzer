import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  findStrings: vi.fn(),
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
    findStrings: mocks.findStrings,
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

import { runFindStrings } from '../find-strings.ts';
import * as loggerModule from '@gitlab-analyzer/core';

const TEST_GITLAB_URL = 'https://gitlab.example.com';
const TEST_PRIVATE_TOKEN = 'test-token-for-vitest';

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

const collectWriteCalls = (spy: ReturnType<typeof vi.spyOn>): string =>
  spy.mock.calls.map((c: readonly unknown[]) => String(c[0])).join('');

beforeEach(() => {
  process.env.GITLAB_URL = TEST_GITLAB_URL;
  process.env.PRIVATE_TOKEN = TEST_PRIVATE_TOKEN;
});

describe('runFindStrings (exported helper)', () => {
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
    mocks.existsSync.mockReset();
    mocks.existsSync.mockReturnValue(false);
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

    expect(result.report.repositories).toEqual([]);
    // No --output → an auto-named file is generated (not stdout).
    expect(result.outputPath).toMatch(/^find-strings-results-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    const [autoPath, payload] = mocks.writeFile.mock.calls[0];
    expect(autoPath).toBe(result.outputPath);
    // The report payload is the new JSON object shape with metadata.
    expect(String(payload)).toContain('"metadata"');
    expect(String(payload)).toContain('"repositories"');

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

    const nestedDir = path.join(
      os.tmpdir(),
      `gitlab-analyzer-mkdir-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      'level2',
    );
    const outputPath = path.join(nestedDir, 'result.json');

    const result = await runFindStrings(['x'], { output: outputPath });

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
    mocks.findStrings.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);

    const result = await runFindStrings(['x'], {});

    expect(mocks.mkdir).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(result.outputPath).toMatch(/^find-strings-results-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
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
    expect(result.outputPath).toMatch(/find-strings-results-\d{4}-\d{2}-\d{2}-\d{4}\.json/);
  });

  it('shows a loader while the repository list is being fetched', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.findStrings.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.mkdir.mockResolvedValue(undefined);

    let resolveProjects!: (v: unknown) => void;
    mocks.getAllProjects.mockReturnValue(
      new Promise((resolve) => {
        resolveProjects = resolve;
      }),
    );

    vi.useFakeTimers();
    try {
      const runPromise = runFindStrings(['x'], {});

      await vi.advanceTimersByTimeAsync(150);

      const duringFetch = collectWriteCalls(stderrSpy);
      expect(duringFetch).toContain('Получение списка репозиториев…');

      resolveProjects([]);
      await runPromise;

      const afterText = collectWriteCalls(stderrSpy);
      expect(afterText).toContain('Будет выполнен поиск по 0 репозиториям:');
    } finally {
      vi.useRealTimers();
    }
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

    expect(mocks.getAllProjects).toHaveBeenCalledTimes(1);

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

  it('captures metadata, repositories and a per-repo error / branchExists=false', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.getAllProjects.mockResolvedValue([
      { id: 1, name: 'good', description: 'G' },
      { id: 2, name: 'badbranch', description: null },
    ]);
    mocks.findStrings.mockImplementation(async (opts) => {
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

    const result = await runFindStrings(['needle'], {
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
    mocks.findStrings.mockResolvedValue([
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

    const result = await runFindStrings(['needle'], { format: 'txt' });

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
    mocks.findStrings.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.getAllProjects.mockResolvedValue([]);
    mocks.repoSelect.mockResolvedValue([]);

    await runFindStrings(['needle'], {});

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

    await runFindStrings(['needle'], { interactive: true });

    expect(mocks.repoSelect).toHaveBeenCalledTimes(1);
    expect(mocks.findStrings).toHaveBeenCalledTimes(1);
    const passedOpts = mocks.findStrings.mock.calls[0][0];
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
    mocks.findStrings.mockResolvedValue([]);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.getAllProjects.mockResolvedValue([
      { id: 1, name: 'alpha', description: null },
    ]);
    mocks.repoSelect.mockResolvedValue([]);

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
    exitSpy.mockRestore();
  });
});
