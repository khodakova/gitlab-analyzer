import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getAllProjects: vi.fn(),
}));

vi.mock('@gitlab-analyzer/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gitlab-analyzer/core')>();
  return {
    ...actual,
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

import { runListRepos } from '../list-repos.ts';

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

describe('runListRepos', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.GITLAB_URL = TEST_GITLAB_URL;
    process.env.PRIVATE_TOKEN = TEST_PRIVATE_TOKEN;
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    mocks.loadConfig.mockReset();
    mocks.getAllProjects.mockReset();
    mocks.getAllProjects.mockResolvedValue([
      { id: 1, name: 'alpha', description: null },
    ]);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('prints sorted names to stdout (one per line) and the count to stderr', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.getAllProjects.mockResolvedValue([
      { id: 2, name: 'zeta', description: null },
      { id: 1, name: 'alpha', description: null },
    ]);

    const repos = await runListRepos({});

    expect(repos).toEqual(['alpha', 'zeta']);
    expect(collectWriteCalls(stdoutSpy)).toBe('alpha\nzeta\n');
    expect(collectWriteCalls(stderrSpy)).toContain(
      'Found 2 repositories matching the filters.',
    );
  });

  it('passes --repo-filter to the project list API and applies --exclude', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.getAllProjects.mockResolvedValue([
      { id: 1, name: 'frontend-app', description: null },
      { id: 2, name: 'wip-repo', description: null },
    ]);

    const repos = await runListRepos({ repoFilter: 'front', exclude: ['wip-repo'] });

    expect(mocks.getAllProjects).toHaveBeenCalledWith('front', expect.anything());
    expect(repos).toEqual(['frontend-app']);
    expect(collectWriteCalls(stdoutSpy)).toBe('frontend-app\n');
    expect(collectWriteCalls(stderrSpy)).toContain('Found 1 repositories');
  });

  it('falls back to config defaults.repoNameFilter / defaults.excludeRepos', async () => {
    mocks.loadConfig.mockResolvedValue({
      ...defaultConfig(),
      defaults: {
        branch: 'develop',
        repoNameFilter: 'backend',
        excludeRepos: ['archived-repo'],
        fileInclude: [],
        fileExclude: [],
      },
    });
    mocks.getAllProjects.mockResolvedValue([
      { id: 1, name: 'backend-api', description: null },
      { id: 2, name: 'archived-repo', description: null },
    ]);

    const repos = await runListRepos({});

    expect(mocks.getAllProjects).toHaveBeenCalledWith('backend', expect.anything());
    expect(repos).toEqual(['backend-api']);
  });

  it('prints nothing to stdout and exits cleanly on an empty result', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.getAllProjects.mockResolvedValue([
      { id: 1, name: 'wip-repo', description: null },
    ]);

    const repos = await runListRepos({ exclude: ['wip-repo'] });

    expect(repos).toEqual([]);
    expect(collectWriteCalls(stdoutSpy)).toBe('');
    expect(collectWriteCalls(stderrSpy)).toContain('No repositories found');
  });

  it('throws a list-repos-specific error when URL/token are missing', async () => {
    delete process.env.GITLAB_URL;
    delete process.env.PRIVATE_TOKEN;
    mocks.loadConfig.mockResolvedValue(defaultConfig());

    await expect(runListRepos({})).rejects.toThrow(
      /Cannot run list-repos — missing required options:[\s\S]*gitlabUrl[\s\S]*PRIVATE_TOKEN/,
    );
    expect(mocks.getAllProjects).not.toHaveBeenCalled();
  });
});
