import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

/**
 * Hoisted module mocks. `vi.hoisted` runs BEFORE `vi.mock`, so the mock
 * functions are real `vi.fn()` instances by the time the mock factory
 * captures them. Paths use `../../` because this file lives at
 * `src/commands/__tests__/fetch-files.test.ts`.
 */
const { listRepoTreeRecursiveMock, fetchBlobRawMock, getAllProjectsMock } = vi.hoisted(() => ({
  listRepoTreeRecursiveMock: vi.fn(),
  fetchBlobRawMock: vi.fn(),
  getAllProjectsMock: vi.fn(),
}));

vi.mock('../../api/repository-tree.ts', () => ({
  listRepoTreeRecursive: listRepoTreeRecursiveMock,
}));

vi.mock('../../api/repository-blobs.ts', () => ({
  fetchBlobRaw: fetchBlobRawMock,
}));

vi.mock('../../utils/get-projects.ts', () => ({
  getAllProjects: getAllProjectsMock,
}));

import { fetchFiles, MAX_EMBED_BYTES } from '../fetch-files.ts';
import { compileMatcher } from '../find-matches.ts';
import type { FetchFilesResult, SaveFileInput } from '../fetch-files.types.ts';
import type { SearchMetrics } from '../find-matches.types.ts';
import type { TreeEntry } from '../../api/repository-tree.ts';
import type { SearchProjectsItem } from '../../types.ts';
import { logger } from '../../utils/logger.ts';

/** Minimal valid SearchProjectsItem factory (copied from find-matches.test.ts). */
function project(overrides: Partial<SearchProjectsItem> & { id: number; name: string | null }): SearchProjectsItem {
  return {
    id: overrides.id,
    name: overrides.name,
    description: overrides.description ?? null,
    name_with_namespace: overrides.name_with_namespace ?? null,
    path: overrides.path ?? null,
    path_with_namespace: overrides.path_with_namespace ?? null,
    created_at: overrides.created_at ?? null,
    default_branch: overrides.default_branch ?? null,
    tag_list: overrides.tag_list ?? [],
    topics: overrides.topics ?? [],
    ssh_url_to_repo: overrides.ssh_url_to_repo ?? null,
    http_url_to_repo: overrides.http_url_to_repo ?? null,
    web_url: overrides.web_url ?? null,
    readme_url: overrides.readme_url ?? null,
    forks_count: overrides.forks_count ?? 0,
    avatar_url: overrides.avatar_url ?? null,
    star_count: overrides.star_count ?? 0,
    last_activity_at: overrides.last_activity_at ?? null,
    namespace: overrides.namespace ?? {
      id: 1,
      name: null,
      path: null,
      kind: null,
      full_path: null,
      parent_id: 0,
      avatar_url: null,
      web_url: null,
    },
    ...(overrides.statistics !== undefined ? { statistics: overrides.statistics } : {}),
  };
}

/** Tree entry factory: GitLab tree entries have no leading slash in `path`. */
function blob(path: string): TreeEntry {
  return { id: `sha-${path}`, name: path.split('/').pop() ?? path, type: 'blob', path, mode: '100644' };
}

describe('compileMatcher (exported for fetchFiles)', () => {
  it('matches patterns without slash by basename', () => {
    const m = compileMatcher('values.yaml.gotmpl');
    expect(m('/deploy/values.yaml.gotmpl')).toBe(true);
    expect(m('/src/other.yaml')).toBe(false);
  });

  it('matches patterns with slash against the normalized full path', () => {
    const m = compileMatcher('**/src/**/*.ts');
    expect(m('/src/a/foo.ts')).toBe(true);
    expect(m('/docs/foo.ts')).toBe(false);
  });
});

describe('fetchFiles', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    listRepoTreeRecursiveMock.mockReset();
    fetchBlobRawMock.mockReset();
    getAllProjectsMock.mockReset();
    warnSpy?.mockRestore();
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  it('exports MAX_EMBED_BYTES = 10 MiB', () => {
    expect(MAX_EMBED_BYTES).toBe(10 * 1024 * 1024);
  });

  it('success: fetches matching blobs, skips non-matching tree entries', async () => {
    getAllProjectsMock.mockResolvedValue([project({ id: 42, name: 'repo-a', web_url: 'https://gitlab.example.com/repo-a' })]);
    listRepoTreeRecursiveMock.mockResolvedValue({
      entries: [blob('src/a.ts'), blob('docs/readme.md')],
      truncated: false,
    });
    fetchBlobRawMock.mockImplementation((_id: number, sha: string) =>
      Promise.resolve(Readable.from([Buffer.from(`content-of-${sha}`)])),
    );
    const saveFile = vi.fn(async (_input: SaveFileInput) => ({ savedAs: null }));

    const result: FetchFilesResult = await fetchFiles({
      patterns: ['**/*.ts'],
      branch: 'develop',
      saveFile,
    });

    expect(listRepoTreeRecursiveMock).toHaveBeenCalledTimes(1);
    expect(listRepoTreeRecursiveMock.mock.calls[0][0]).toBe(42);
    expect(listRepoTreeRecursiveMock.mock.calls[0][1]).toBe('develop');
    expect(fetchBlobRawMock).toHaveBeenCalledTimes(1);
    expect(fetchBlobRawMock.mock.calls[0][0]).toBe(42);
    expect(fetchBlobRawMock.mock.calls[0][1]).toBe('sha-src/a.ts');

    expect(result.repos).toHaveLength(1);
    const repo = result.repos[0];
    expect(repo).toMatchObject({
      projectId: 42,
      projectName: 'repo-a',
      webUrl: 'https://gitlab.example.com/repo-a',
      branch: 'develop',
      status: 'fetched',
      filesTotal: 1,
      filesFetched: 1,
      filesFailed: 0,
      error: null,
      truncated: false,
    });
    expect(repo.files).toHaveLength(1);
    expect(repo.files[0]).toEqual({
      projectId: 42,
      repo: 'repo-a',
      branch: 'develop',
      path: 'src/a.ts',
      bytes: Buffer.from('content-of-sha-src/a.ts').length,
      status: 'fetched',
      content: 'content-of-sha-src/a.ts',
      savedAs: null,
      error: null,
    });

    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(saveFile.mock.calls[0][0]).toMatchObject({
      projectId: 42,
      repo: 'repo-a',
      branch: 'develop',
      path: 'src/a.ts',
      status: 'fetched',
    });
    expect(saveFile.mock.calls[0][0].data).toBeInstanceOf(Buffer);
    expect(saveFile.mock.calls[0][0].bytes).toBe(Buffer.from('content-of-sha-src/a.ts').length);
  });

  it('binary: invalid UTF-8 -> status binary, content null, warn, saveFile with Buffer', async () => {
    getAllProjectsMock.mockResolvedValue([project({ id: 1, name: 'r' })]);
    listRepoTreeRecursiveMock.mockResolvedValue({ entries: [blob('img/logo.png')], truncated: false });
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
    fetchBlobRawMock.mockResolvedValue(Readable.from([raw]));

    const result = await fetchFiles({ patterns: ['**/*'], branch: 'main' });

    expect(result.repos[0].status).toBe('fetched');
    expect(result.repos[0].files[0]).toMatchObject({
      status: 'binary',
      content: null,
      bytes: raw.length,
      error: null,
    });
    const warnMsg = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join(' ').toLowerCase();
    expect(warnMsg).toContain('binary');
    expect(warnMsg).toContain('saved separately');
  });

  it('binary: saveFile receives data as Buffer with status binary', async () => {
    getAllProjectsMock.mockResolvedValue([project({ id: 1, name: 'r' })]);
    listRepoTreeRecursiveMock.mockResolvedValue({ entries: [blob('img/logo.png')], truncated: false });
    fetchBlobRawMock.mockResolvedValue(Readable.from([Buffer.from([0xff, 0xfe])]));
    const saveFile = vi.fn(async (_input: SaveFileInput) => ({ savedAs: null }));

    await fetchFiles({ patterns: ['**/*'], branch: 'main', saveFile });

    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(saveFile.mock.calls[0][0]).toMatchObject({ status: 'binary', bytes: 2 });
    expect(saveFile.mock.calls[0][0].data).toBeInstanceOf(Buffer);
  });

  it('large: stream exceeding MAX_EMBED_BYTES -> content null, saveFile gets Readable with FULL content from the beginning', async () => {
    const MB = 1024 * 1024;
    const c1 = Buffer.alloc(5 * MB, 0x61);
    const c2 = Buffer.alloc(5 * MB, 0x62);
    const c3 = Buffer.alloc(1 * MB, 0x63);
    const full = Buffer.concat([c1, c2, c3]);
    getAllProjectsMock.mockResolvedValue([project({ id: 1, name: 'r' })]);
    listRepoTreeRecursiveMock.mockResolvedValue({ entries: [blob('big/dump.bin')], truncated: false });
    fetchBlobRawMock.mockResolvedValue(Readable.from([c1, c2, c3]));

    const saveInputs: SaveFileInput[] = [];
    const result = await fetchFiles({
      patterns: ['**/*'],
      branch: 'main',
      saveFile: async (input) => {
        saveInputs.push(input);
        return { savedAs: 'big.bin' };
      },
    });

    expect(saveInputs).toHaveLength(1);
    expect(saveInputs[0]).toMatchObject({ status: 'large', bytes: null, path: 'big/dump.bin' });
    expect(saveInputs[0].data).toBeInstanceOf(Readable);

    // The pass-through stream must yield the FULL content from the start,
    // including every byte consumed before the limit was hit.
    const chunks: Buffer[] = [];
    for await (const c of saveInputs[0].data as Readable) {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
    }
    expect(Buffer.concat(chunks).equals(full)).toBe(true);

    expect(result.repos[0].status).toBe('fetched');
    expect(result.repos[0].files[0]).toMatchObject({
      status: 'large',
      content: null,
      bytes: null,
      savedAs: 'big.bin',
      error: null,
    });
  });

  it('tree 404 -> repo error, zero blob requests, onProgress carries the error', async () => {
    getAllProjectsMock.mockResolvedValue([project({ id: 42, name: 'repo-a' })]);
    listRepoTreeRecursiveMock.mockRejectedValue(new Error('Request failed with status code 404'));
    const progress = vi.fn();

    const result = await fetchFiles({
      patterns: ['**/*'],
      branch: 'develop',
      onProgress: progress,
    });

    expect(result.repos[0]).toMatchObject({
      projectId: 42,
      projectName: 'repo-a',
      status: 'error',
      filesTotal: 0,
      filesFetched: 0,
      filesFailed: 0,
      truncated: false,
      files: [],
    });
    expect(result.repos[0].error).toContain('404');
    expect(fetchBlobRawMock).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith(1, 1, 'repo-a', 'Request failed with status code 404');
  });

  it('tree 403 -> repo error (branchExists is the CLI\'s job, not core)', async () => {
    getAllProjectsMock.mockResolvedValue([project({ id: 42, name: 'repo-a' })]);
    listRepoTreeRecursiveMock.mockRejectedValue(new Error('Request failed with status code 403'));

    const result = await fetchFiles({ patterns: ['**/*'], branch: 'develop' });

    expect(result.repos[0].status).toBe('error');
    expect(result.repos[0].error).toContain('403');
    expect(fetchBlobRawMock).not.toHaveBeenCalled();
  });

  it('blob fetch failure -> file failed with bytes null, repo partial, saveFile not called', async () => {
    getAllProjectsMock.mockResolvedValue([project({ id: 1, name: 'r' })]);
    listRepoTreeRecursiveMock.mockResolvedValue({ entries: [blob('src/a.ts')], truncated: false });
    fetchBlobRawMock.mockRejectedValue(new Error('timeout of 30000ms exceeded'));
    const saveFile = vi.fn(async (_input: SaveFileInput) => ({ savedAs: null }));

    const result = await fetchFiles({ patterns: ['**/*'], branch: 'develop', saveFile });

    expect(result.repos[0].status).toBe('partial');
    expect(result.repos[0].filesTotal).toBe(1);
    expect(result.repos[0].filesFetched).toBe(0);
    expect(result.repos[0].filesFailed).toBe(1);
    expect(result.repos[0].files[0]).toMatchObject({
      status: 'failed',
      bytes: null,
      savedAs: null,
    });
    expect(result.repos[0].files[0].error).toContain('timeout');
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('fileExclude wins over the positional include patterns', async () => {
    getAllProjectsMock.mockResolvedValue([project({ id: 1, name: 'r' })]);
    listRepoTreeRecursiveMock.mockResolvedValue({
      entries: [blob('src/keep.ts'), blob('src/skip.test.ts')],
      truncated: false,
    });
    fetchBlobRawMock.mockResolvedValue(Readable.from([Buffer.from('x')]));

    const result = await fetchFiles({
      patterns: ['**/*.ts'],
      branch: 'main',
      fileExclude: ['**/*.test.ts'],
    });

    expect(fetchBlobRawMock).toHaveBeenCalledTimes(1);
    expect(result.repos[0].files).toHaveLength(1);
    expect(result.repos[0].files[0].path).toBe('src/keep.ts');
  });

  it('no matching files -> repo not-found, no blob requests', async () => {
    getAllProjectsMock.mockResolvedValue([project({ id: 1, name: 'r' })]);
    listRepoTreeRecursiveMock.mockResolvedValue({ entries: [blob('docs/x.md')], truncated: false });

    const result = await fetchFiles({ patterns: ['**/*.ts'], branch: 'main' });

    expect(result.repos[0].status).toBe('not-found');
    expect(result.repos[0].files).toEqual([]);
    expect(fetchBlobRawMock).not.toHaveBeenCalled();
  });

  it('truncated tree -> repo partial even without failed files', async () => {
    getAllProjectsMock.mockResolvedValue([project({ id: 1, name: 'r' })]);
    listRepoTreeRecursiveMock.mockResolvedValue({ entries: [blob('src/a.ts')], truncated: true });
    fetchBlobRawMock.mockResolvedValue(Readable.from([Buffer.from('x')]));

    const result = await fetchFiles({ patterns: ['**/*'], branch: 'main' });

    expect(result.repos[0].status).toBe('partial');
    expect(result.repos[0].truncated).toBe(true);
  });

  it('filters: null-name dropped, excludeRepos dropped, selectedRepos intersection kept', async () => {
    getAllProjectsMock.mockResolvedValue([
      project({ id: 42, name: 'repo-a' }),
      project({ id: 1, name: null }),
      project({ id: 2, name: 'excluded-repo' }),
      project({ id: 7, name: 'not-selected' }),
    ]);
    listRepoTreeRecursiveMock.mockResolvedValue({ entries: [blob('src/a.ts')], truncated: false });
    fetchBlobRawMock.mockResolvedValue(Readable.from([Buffer.from('x')]));

    const result = await fetchFiles({
      patterns: ['**/*'],
      branch: 'develop',
      excludeRepos: ['excluded-repo'],
      selectedRepos: [{ id: 42, name: 'repo-a' }],
    });

    expect(listRepoTreeRecursiveMock).toHaveBeenCalledTimes(1);
    expect(listRepoTreeRecursiveMock.mock.calls[0][0]).toBe(42);
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].projectName).toBe('repo-a');
  });

  it('projects option provided -> getAllProjects is never called', async () => {
    listRepoTreeRecursiveMock.mockResolvedValue({ entries: [blob('src/a.ts')], truncated: false });
    fetchBlobRawMock.mockResolvedValue(Readable.from([Buffer.from('x')]));

    const result = await fetchFiles({
      patterns: ['**/*'],
      branch: 'develop',
      projects: [project({ id: 42, name: 'repo-a' })],
    });

    expect(getAllProjectsMock).not.toHaveBeenCalled();
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].projectId).toBe(42);
  });

  it('concurrency=1 processes repos strictly sequentially', async () => {
    let active = 0;
    let maxActive = 0;
    const guard = async <T>(p: Promise<T>): Promise<T> => {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        return await p;
      } finally {
        active--;
      }
    };
    getAllProjectsMock.mockResolvedValue([project({ id: 1, name: 'r1' }), project({ id: 2, name: 'r2' })]);
    listRepoTreeRecursiveMock.mockImplementation((id: number) =>
      guard(Promise.resolve({ entries: [blob(`src/file${id}.ts`)], truncated: false })),
    );
    fetchBlobRawMock.mockImplementation(() => guard(Promise.resolve(Readable.from([Buffer.from('x')]))));

    await fetchFiles({ patterns: ['**/*'], branch: 'develop', concurrency: 1 });

    expect(maxActive).toBe(1);
  });

  it('pushes per-repo entries into metrics.perRepo when provided', async () => {
    getAllProjectsMock.mockResolvedValue([project({ id: 42, name: 'repo-a' })]);
    listRepoTreeRecursiveMock.mockResolvedValue({ entries: [blob('src/a.ts')], truncated: false });
    fetchBlobRawMock.mockResolvedValue(Readable.from([Buffer.from('x')]));

    const metrics: SearchMetrics = {
      list: { listMs: 0, pagesFetched: 0, reposFound: 0 },
      perRepo: [],
      summary: {},
    };
    await fetchFiles({ patterns: ['**/*'], branch: 'develop', metrics });

    expect(metrics.perRepo).toHaveLength(1);
    const entry = metrics.perRepo[0] as Record<string, unknown>;
    expect(entry.projectId).toBe(42);
    expect(entry.projectName).toBe('repo-a');
    expect(entry.filesScanned).toBe(1);
    expect(entry.filesMatched).toBe(1);
    expect(typeof entry.totalMs).toBe('number');
  });
});
