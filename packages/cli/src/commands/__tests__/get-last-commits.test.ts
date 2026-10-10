import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getLastCommits: vi.fn(),
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
    getLastCommits: mocks.getLastCommits,
    loadConfig: mocks.loadConfig,
  };
});

vi.mock('@gitlab-analyzer/core/internal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gitlab-analyzer/core/internal')>();
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

import { runGetLastCommits, assertValidGlob } from '../get-last-commits.ts';

const TEST_GITLAB_URL = 'https://gitlab.example.com';
const TEST_PRIVATE_TOKEN = 'test-token-for-vitest';

const baseResult = () => [
  {
    projectId: 42,
    projectName: 'alpha',
    webUrl: 'https://gitlab.example.com/alpha',
    branch: 'main',
    error: null,
    failed: [],
    results: [
      {
        path: null,
        commitId: 'sha-1',
        shortId: 'abc1234',
        title: 'Fix bug',
        authorName: 'Jane Doe',
        committedDate: '2026-01-02T10:00:00.000Z',
        webUrl: 'https://gitlab.example.com/alpha/-/commit/abc1234',
      },
    ],
  },
];

beforeEach(() => {
  process.env.GITLAB_URL = TEST_GITLAB_URL;
  process.env.PRIVATE_TOKEN = TEST_PRIVATE_TOKEN;
});

describe('runGetLastCommits', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.existsSync.mockReturnValue(false);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.getAllProjects.mockResolvedValue([{ id: 42, name: 'alpha', description: null }]);
    // runGetLastCommits never reads config — the resolver must not be fed one.
    mocks.loadConfig.mockRejectedValue(new Error('config must not be read'));
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('auto-names the report get-last-commits-results-<DATE>.json', async () => {
    mocks.getLastCommits.mockResolvedValue(baseResult());

    const { outputPath } = await runGetLastCommits({});

    expect(outputPath).toMatch(/^get-last-commits-results-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile.mock.calls[0][0]).toBe(outputPath);
  });

  it('appends -1 to the auto name on collision', async () => {
    mocks.getLastCommits.mockResolvedValue(baseResult());
    mocks.existsSync.mockImplementation((p: string) => !p.includes('-1.'));

    const { outputPath } = await runGetLastCommits({});

    expect(outputPath).toMatch(/^get-last-commits-results-\d{4}-\d{2}-\d{2}-\d{4}-1\.json$/);
  });

  it('--format txt + -o x.json → error (exit 1 via the action handler)', async () => {
    mocks.getLastCommits.mockResolvedValue(baseResult());

    await expect(runGetLastCommits({ format: 'txt', output: 'x.json' })).rejects.toThrow(
      /--format txt conflicts with output path "x\.json"/,
    );
  });

  it('invalid --file glob → throws BEFORE any repo processing (no network calls)', async () => {
    mocks.getLastCommits.mockResolvedValue([]);

    await expect(runGetLastCommits({ file: '**/*[unclosed' })).rejects.toThrow(
      /Invalid --file glob pattern/,
    );

    expect(mocks.getAllProjects).not.toHaveBeenCalled();
    expect(mocks.getLastCommits).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('per-path failure: failed is filled, error stays null, JSON report carries both', async () => {
    mocks.getLastCommits.mockResolvedValue([
      {
        projectId: 42,
        projectName: 'alpha',
        webUrl: 'https://gitlab.example.com/alpha',
        branch: 'develop',
        error: null,
        failed: [{ path: 'broken.yaml', error: 'commits request timed out (60s)' }],
        results: [
          {
            path: 'ok.yaml',
            commitId: 'sha-2',
            shortId: 'def5678',
            title: 'T',
            authorName: 'A',
            committedDate: '2026-01-02T10:00:00.000Z',
            webUrl: 'u',
          },
        ],
      },
    ]);

    const { report, outputPath } = await runGetLastCommits({ file: '**/*.yaml' });

    expect(outputPath).toMatch(/\.json$/);
    expect(report.repositories).toHaveLength(1);
    const repo = report.repositories[0];
    expect(repo.error).toBeNull();
    expect(repo.branchExists).toBe(true);
    expect(repo.failed).toEqual([{ path: 'broken.yaml', error: 'commits request timed out (60s)' }]);
    expect(report.metadata.file).toBe('**/*.yaml');
    expect(report.metadata.branch).toBeNull();
  });

  it('--format txt renders metadata and per-path result lines', async () => {
    mocks.getLastCommits.mockResolvedValue(baseResult());

    const { outputPath } = await runGetLastCommits({ format: 'txt' });

    expect(outputPath).toMatch(/^get-last-commits-results-\d{4}-\d{2}-\d{2}-\d{4}\.txt$/);
    const payload = String(mocks.writeFile.mock.calls[0][1]);
    expect(payload).toContain('GitLab last-commit report');
    expect(payload).toContain('Branch: (not set — resolved per repo)');
    expect(payload).toContain('---- alpha (id: 42) ----');
    expect(payload).toContain('URL: https://gitlab.example.com/alpha');
    expect(payload).toContain('Branch exists: yes');
    expect(payload).toContain('abc1234');
    expect(payload).toContain('Jane Doe');
  });

  it('--stdout additionally writes the report to stdout', async () => {
    mocks.getLastCommits.mockResolvedValue(baseResult());

    await runGetLastCommits({ stdout: true });

    const stdoutText = stdoutSpy.mock.calls
      .map((c: readonly unknown[]) => String(c[0]))
      .join('');
    expect(stdoutText).toContain('"projectName": "alpha"');
    expect(stdoutText).toContain('"metadata"');
  });

  it('passes CLI flags through to getLastCommits (branch undefined when -b omitted)', async () => {
    mocks.getLastCommits.mockResolvedValue(baseResult());

    await runGetLastCommits({ file: '**/*.yaml', branch: 'release/1.0', concurrency: 2 });

    expect(mocks.getLastCommits).toHaveBeenCalledTimes(1);
    const passed = mocks.getLastCommits.mock.calls[0][0];
    expect(passed.branch).toBe('release/1.0');
    expect(passed.file).toBe('**/*.yaml');
    expect(passed.concurrency).toBe(2);
    expect(passed.projects).toBeDefined();
  });

  it('branchExists is false when the repo error looks like a missing branch', async () => {
    mocks.getLastCommits.mockResolvedValue([
      {
        projectId: 9,
        projectName: 'no-branch',
        webUrl: null,
        branch: 'develop',
        error: 'Request failed with status code 404',
        failed: [],
        results: [],
      },
    ]);

    const { report } = await runGetLastCommits({});

    expect(report.repositories[0]).toMatchObject({
      projectName: 'no-branch',
      branchExists: false,
      error: 'Request failed with status code 404',
      results: [],
    });
  });
});

describe('assertValidGlob', () => {
  it('accepts valid patterns, including closers picomatch treats as literals', () => {
    expect(() => assertValidGlob('**/*.yaml')).not.toThrow();
    expect(() => assertValidGlob('{a,b}/**/*.ts')).not.toThrow();
    expect(() => assertValidGlob('[!]')).not.toThrow(); // negated class
    expect(() => assertValidGlob('\\[abc\\]')).not.toThrow(); // escaped brackets
    expect(() => assertValidGlob('data].txt')).not.toThrow(); // bare closer = literal
    expect(() => assertValidGlob('[a)b]')).not.toThrow(); // closer inside a class
    expect(() => assertValidGlob('[]]')).not.toThrow(); // class containing ]
    expect(() => assertValidGlob('a]b}c)')).not.toThrow();
  });

  it('rejects unclosed openers', () => {
    expect(() => assertValidGlob('**/*[unclosed')).toThrow(/unclosed "\["/);
    expect(() => assertValidGlob('{a,b')).toThrow(/unclosed "\{"/);
    expect(() => assertValidGlob('src/(dir')).toThrow(/unclosed "\("/);
    expect(() => assertValidGlob('[a(b')).toThrow(/unclosed/);
    // Escaped opener never opens — still unclosed for the real one.
    expect(() => assertValidGlob('\\[ [')).toThrow(/unclosed "\["/);
  });
});
