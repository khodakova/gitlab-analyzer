import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Hoisted module mocks (same pattern as src/api/__tests__/repository-tree.test.ts).
 * The command under test lives at `src/commands/get-last-commits.ts`, so the
 * mock specifiers mirror its import specifiers from `__tests__/`: `../api/commits.ts`,
 * `../api/repository-tree.ts`, `../utils/get-projects.ts`, `../utils/logger.ts`.
 */
const { getCommitsMock, listTreeMock, getAllProjectsMock, warnMock } = vi.hoisted(() => ({
  getCommitsMock: vi.fn(),
  listTreeMock: vi.fn(),
  getAllProjectsMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('../../api/commits.ts', () => ({
  getCommits: getCommitsMock,
}));

vi.mock('../../api/repository-tree.ts', () => ({
  listRepoTreeRecursive: listTreeMock,
}));

vi.mock('../../utils/get-projects.ts', () => ({
  getAllProjects: getAllProjectsMock,
}));

vi.mock('../../utils/logger.ts', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
  },
  isLoggingEnabled: vi.fn(() => false),
}));

import { getLastCommits } from '../get-last-commits.ts';
import type { SearchProjectsItem } from '../../types.ts';

function project(overrides: Partial<SearchProjectsItem> = {}): SearchProjectsItem {
  return {
    id: 42,
    description: null,
    name: 'repo-a',
    name_with_namespace: 'group/repo-a',
    path: 'repo-a',
    path_with_namespace: 'group/repo-a',
    created_at: null,
    default_branch: 'main',
    tag_list: [],
    topics: [],
    ssh_url_to_repo: null,
    http_url_to_repo: null,
    web_url: 'https://gitlab.example.com/group/repo-a',
    readme_url: null,
    forks_count: 0,
    avatar_url: null,
    star_count: 0,
    last_activity_at: null,
    namespace: {
      id: 1,
      name: null,
      path: null,
      kind: null,
      full_path: null,
      parent_id: 1,
      avatar_url: null,
      web_url: null,
    },
    ...overrides,
  };
}

function commit(shortId: string) {
  return {
    id: `sha-${shortId}`,
    short_id: shortId,
    title: `Title ${shortId}`,
    message: `message ${shortId}`,
    author_name: 'Jane Doe',
    author_email: 'jane@example.com',
    authored_date: '2026-01-02T10:00:00.000Z',
    committer_name: 'Jane Doe',
    committer_email: 'jane@example.com',
    committed_date: '2026-01-02T10:00:00.000Z',
    parent_ids: [],
    web_url: `https://gitlab.example.com/repo-a/-/commit/${shortId}`,
  };
}

function treeEntry(path: string, type: 'blob' | 'tree' = 'blob') {
  return { id: `id-${path}`, name: path.split('/').pop() ?? path, type, path, mode: '100644' };
}

describe('getLastCommits', () => {
  beforeEach(() => {
    getCommitsMock.mockReset();
    listTreeMock.mockReset();
    getAllProjectsMock.mockReset();
    warnMock.mockReset();
  });

  describe('HEAD mode (no --file)', () => {
    it('case 1: one commits request with ref_name + per_page=1 → one entry with path: null', async () => {
      getCommitsMock.mockResolvedValueOnce([commit('abc1234')]);

      const results = await getLastCommits({ projects: [project()] });

      expect(getCommitsMock).toHaveBeenCalledTimes(1);
      expect(getCommitsMock).toHaveBeenCalledWith(42, { ref_name: 'main', per_page: 1 });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        projectId: 42,
        projectName: 'repo-a',
        webUrl: 'https://gitlab.example.com/group/repo-a',
        branch: 'main',
        error: null,
        failed: [],
        truncated: false,
      });
      expect(results[0].results).toHaveLength(1);
      expect(results[0].results[0]).toEqual({
        path: null,
        commitId: 'sha-abc1234',
        shortId: 'abc1234',
        title: 'Title abc1234',
        authorName: 'Jane Doe',
        committedDate: '2026-01-02T10:00:00.000Z',
        webUrl: 'https://gitlab.example.com/repo-a/-/commit/abc1234',
      });
    });

    it('case 2: branch resolution per repo: opts.branch > default_branch > develop', async () => {
      getCommitsMock.mockResolvedValue([commit('x')]);

      await getLastCommits({
        branch: 'release/1.0',
        projects: [
          project({ id: 1, name: 'a', default_branch: 'main' }),
          project({ id: 2, name: 'b', default_branch: null }),
        ],
      });

      expect(getCommitsMock).toHaveBeenNthCalledWith(1, 1, { ref_name: 'release/1.0', per_page: 1 });
      expect(getCommitsMock).toHaveBeenNthCalledWith(2, 2, { ref_name: 'release/1.0', per_page: 1 });

      await getLastCommits({
        projects: [
          project({ id: 3, name: 'c', default_branch: 'master' }),
          project({ id: 4, name: 'd', default_branch: null }),
        ],
      });
      expect(getCommitsMock).toHaveBeenNthCalledWith(3, 3, { ref_name: 'master', per_page: 1 });
      expect(getCommitsMock).toHaveBeenNthCalledWith(4, 4, { ref_name: 'develop', per_page: 1 });
    });

    it('case 3: repo-level error (403/missing branch) → error text, empty results, other repos still processed', async () => {
      getCommitsMock
        .mockRejectedValueOnce(new Error('Request failed with status code 404'))
        .mockResolvedValueOnce([commit('ok')]);

      const results = await getLastCommits({
        projects: [
          project({ id: 1, name: 'broken' }),
          project({ id: 2, name: 'healthy' }),
        ],
      });

      expect(results).toHaveLength(2);
      const failed = results.find((r) => r.projectName === 'broken');
      expect(failed).toMatchObject({
        projectId: 1,
        error: 'Request failed with status code 404',
        failed: [],
        results: [],
      });
      const ok = results.find((r) => r.projectName === 'healthy');
      expect(ok?.error).toBeNull();
      expect(ok?.results).toHaveLength(1);
    });
  });

  describe('per-file mode (--file)', () => {
    it('case 4: tree listing → matcher filters blobs → one commits request per matched path → one entry per file', async () => {
      listTreeMock.mockResolvedValueOnce({
        entries: [
          treeEntry('deploy/first.yaml'),
          treeEntry('README.md'),
          treeEntry('charts', 'tree'), // directories never match
          treeEntry('deploy/nested/second.yaml'),
        ],
        truncated: false,
      });
      getCommitsMock.mockImplementation(async (_projectId, params) => [
        commit(params.path === 'deploy/first.yaml' ? 'aaa1111' : 'bbb2222'),
      ]);

      const results = await getLastCommits({ file: '**/*.yaml', projects: [project()] });

      expect(listTreeMock).toHaveBeenCalledWith(42, 'main', { projectName: 'repo-a' });
      expect(getCommitsMock).toHaveBeenCalledTimes(2);
      expect(getCommitsMock).toHaveBeenCalledWith(42, {
        path: 'deploy/first.yaml',
        ref_name: 'main',
        per_page: 1,
      });
      expect(getCommitsMock).toHaveBeenCalledWith(42, {
        path: 'deploy/nested/second.yaml',
        ref_name: 'main',
        per_page: 1,
      });
      expect(results).toHaveLength(1);
      expect(results[0].results.map((r) => r.path)).toEqual([
        'deploy/first.yaml',
        'deploy/nested/second.yaml',
      ]);
      expect(results[0].results[0]).toMatchObject({
        path: 'deploy/first.yaml',
        shortId: 'aaa1111',
        commitId: 'sha-aaa1111',
        title: 'Title aaa1111',
        authorName: 'Jane Doe',
      });
    });

    it('case 5: pattern without slash matches basename (find-matches glob semantics)', async () => {
      listTreeMock.mockResolvedValueOnce({
        entries: [treeEntry('src/deep/pkg.json'), treeEntry('other/yaml')],
        truncated: false,
      });
      getCommitsMock.mockImplementation(async (_projectId, params) => [commit(params.path)]);

      const results = await getLastCommits({ file: 'pkg.json', projects: [project()] });

      expect(results[0].results.map((r) => r.path)).toEqual(['src/deep/pkg.json']);
    });

    it('case 6: empty match (nothing found) → results: [], failed: [], error: null', async () => {
      listTreeMock.mockResolvedValueOnce({
        entries: [treeEntry('README.md')],
        truncated: false,
      });

      const results = await getLastCommits({ file: '**/*.yaml', projects: [project()] });

      expect(getCommitsMock).not.toHaveBeenCalled();
      expect(results[0]).toMatchObject({ error: null, failed: [], results: [] });
    });

    it('case 7: tree-listing failure → repo-level error, empty results', async () => {
      listTreeMock.mockRejectedValueOnce(new Error('Request failed with status code 403'));

      const results = await getLastCommits({ file: '**/*.yaml', projects: [project()] });

      expect(getCommitsMock).not.toHaveBeenCalled();
      expect(results[0]).toMatchObject({
        error: 'Request failed with status code 403',
        failed: [],
        results: [],
      });
    });

    it('case 8: one failed per-path request does not abort the repo — {path, error} in failed, others processed', async () => {
      listTreeMock.mockResolvedValueOnce({
        entries: [treeEntry('a.yaml'), treeEntry('b.yaml'), treeEntry('c.yaml')],
        truncated: false,
      });
      getCommitsMock.mockImplementation(async (_projectId, params) => {
        if (params.path === 'b.yaml') {
          throw new Error('commits request timed out (60s)');
        }
        return [commit(params.path === 'a.yaml' ? 'aaa' : 'ccc')];
      });

      const results = await getLastCommits({ file: '**/*.yaml', projects: [project()] });

      expect(results[0].error).toBeNull();
      expect(results[0].failed).toEqual([
        { path: 'b.yaml', error: 'commits request timed out (60s)' },
      ]);
      expect(results[0].results.map((r) => r.path)).toEqual(['a.yaml', 'c.yaml']);
    });

    it('case 9: matched path with no reachable commit → no entry for that path (not an error)', async () => {
      listTreeMock.mockResolvedValueOnce({
        entries: [treeEntry('moved.yaml'), treeEntry('ok.yaml')],
        truncated: false,
      });
      getCommitsMock.mockImplementation(async (_projectId, params) =>
        params.path === 'moved.yaml' ? [] : [commit('ccc')],
      );

      const results = await getLastCommits({ file: '**/*.yaml', projects: [project()] });

      expect(results[0]).toMatchObject({ error: null, failed: [] });
      expect(results[0].results.map((r) => r.path)).toEqual(['ok.yaml']);
    });

    it('case 10: truncated tree → truncated: true on the per-file result', async () => {
      listTreeMock.mockResolvedValueOnce({
        entries: [treeEntry('a.yaml')],
        truncated: true,
      });
      getCommitsMock.mockResolvedValue([commit('aaa')]);

      const results = await getLastCommits({ file: '**/*.yaml', projects: [project()] });

      expect(results[0]).toMatchObject({ error: null, truncated: true });
    });
  });

  it('case 11: excludeRepos and selectedRepos filter the candidate set (no per-repo calls)', async () => {
    getCommitsMock.mockResolvedValue([commit('x')]);

    await getLastCommits({
      excludeRepos: ['skip-me'],
      selectedRepos: [{ id: 42, name: 'repo-a' }],
      projects: [
        project({ id: 42, name: 'repo-a' }),
        project({ id: 1, name: 'skip-me' }),
        project({ id: 3, name: 'other' }),
      ],
    });

    expect(getCommitsMock).toHaveBeenCalledTimes(1);
    expect(getCommitsMock).toHaveBeenCalledWith(42, { ref_name: 'main', per_page: 1 });
  });
});
