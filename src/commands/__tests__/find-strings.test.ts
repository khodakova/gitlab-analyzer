import { describe, it, expect, beforeEach, vi } from 'vitest';
import JSZip from 'jszip';

/**
 * Hoisted module mocks. `vi.hoisted` runs BEFORE `vi.mock`, so the mock
 * functions are real `vi.fn()` instances by the time the mock factory
 * captures them. This must stay at the top of the file — `vi.mock` is
 * hoisted by Vitest to run before any imports.
 *
 * Paths use `../../` because this file lives at
 * `src/commands/__tests__/find-strings.test.ts` (one level deeper than
 * co-located would be).
 */
const { getAllProjectsMock, getProjectArchiveMock } = vi.hoisted(() => ({
  getAllProjectsMock: vi.fn(),
  getProjectArchiveMock: vi.fn(),
}));

vi.mock('../../utils/get-projects.ts', () => ({
  getAllProjects: getAllProjectsMock,
}));

vi.mock('../../api/project-archive.ts', () => ({
  getProjectArchive: getProjectArchiveMock,
}));

import { findStrings } from '../find-strings.ts';
import type { SearchProjectsItem } from '../../types.ts';

/**
 * Build a real in-memory ZIP archive (NOT a JSZip mock). Paths MUST use
 * leading slashes (`/src/foo.ts`) to match real GitLab archive structure
 * — otherwise the default `pathFilter='/src/'` won't match anything.
 */
async function makeZip(files: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  return await zip.generateAsync({ type: 'arraybuffer' });
}

/** Minimal valid SearchProjectsItem factory. */
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
  };
}

describe('findStrings', () => {
  beforeEach(() => {
    getAllProjectsMock.mockReset();
    getProjectArchiveMock.mockReset();
  });

  describe('case 1: end-to-end match detection', () => {
    it('returns MatchResult with correct shape when search string is found', async () => {
      const archive = await makeZip({
        '/src/foo.ts': 'const greeting = "hello";\nconst target = "my-secret";\n',
      });

      getAllProjectsMock.mockResolvedValue([project({ id: 42, name: 'repo-a', description: 'A repo' })]);
      getProjectArchiveMock.mockResolvedValue(archive);

      const results = await findStrings({
        searchStrings: ['my-secret'],
        branch: 'develop',
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        projectId: 42,
        projectName: 'repo-a',
        projectDescription: 'A repo',
        resultsLength: 1,
      });
      expect(results[0].results).toHaveLength(1);
      expect(results[0].results[0].filename).toBe('/src/foo.ts');
      expect(results[0].results[0].matches).toEqual(['my-secret']);
      expect(results[0].results[0].content).toEqual([
        'const greeting = "hello";',
        'const target = "my-secret";',
        '',
      ]);
    });
  });

  describe('case 2: pathFilter', () => {
    it('only includes files whose path contains pathFilter substring', async () => {
      const archive = await makeZip({
        '/src/keep.ts': 'TARGET',
        '/docs/skip.ts': 'TARGET',
        '/README.md': 'TARGET',
      });

      getAllProjectsMock.mockResolvedValue([project({ id: 1, name: 'r' })]);
      getProjectArchiveMock.mockResolvedValue(archive);

      const results = await findStrings({
        searchStrings: ['TARGET'],
        branch: 'main',
      });

      expect(results[0].results).toHaveLength(1);
      expect(results[0].results[0].filename).toBe('/src/keep.ts');
    });

    it('default pathFilter is "/src/"', async () => {
      const archive = await makeZip({
        '/src/included.ts': 'X',
        '/lib/excluded.ts': 'X',
      });

      getAllProjectsMock.mockResolvedValue([project({ id: 1, name: 'r' })]);
      getProjectArchiveMock.mockResolvedValue(archive);

      const results = await findStrings({
        searchStrings: ['X'],
        branch: 'main',
        // no pathFilter → default '/src/'
      });

      expect(results[0].results.map((m) => m.filename)).toEqual(['/src/included.ts']);
    });
  });

  describe('case 3: includeTests flag', () => {
    it('skips .test.ts files by default', async () => {
      const archive = await makeZip({
        '/src/foo.ts': 'TARGET',
        '/src/foo.test.ts': 'TARGET',
      });

      getAllProjectsMock.mockResolvedValue([project({ id: 1, name: 'r' })]);
      getProjectArchiveMock.mockResolvedValue(archive);

      const results = await findStrings({
        searchStrings: ['TARGET'],
        branch: 'main',
        // no includeTests → default false
      });

      expect(results[0].results.map((m) => m.filename)).toEqual(['/src/foo.ts']);
    });

    it('includes .test.ts files when includeTests=true', async () => {
      const archive = await makeZip({
        '/src/foo.ts': 'TARGET',
        '/src/foo.test.ts': 'TARGET',
      });

      getAllProjectsMock.mockResolvedValue([project({ id: 1, name: 'r' })]);
      getProjectArchiveMock.mockResolvedValue(archive);

      const results = await findStrings({
        searchStrings: ['TARGET'],
        branch: 'main',
        includeTests: true,
      });

      expect(results[0].results.map((m) => m.filename).sort()).toEqual([
        '/src/foo.test.ts',
        '/src/foo.ts',
      ]);
    });
  });

  describe('case 4: excludeRepos', () => {
    it('skips projects whose name is in excludeRepos list', async () => {
      const archive = await makeZip({ '/src/x.ts': 'OK' });

      getAllProjectsMock.mockResolvedValue([
        project({ id: 1, name: 'keep-1' }),
        project({ id: 2, name: 'skip-me' }),
        project({ id: 3, name: 'keep-2' }),
      ]);
      getProjectArchiveMock.mockResolvedValue(archive);

      const results = await findStrings({
        searchStrings: ['OK'],
        branch: 'main',
        excludeRepos: ['skip-me'],
      });

      expect(getProjectArchiveMock).toHaveBeenCalledTimes(2);
      expect(results.map((r) => r.projectName).sort()).toEqual(['keep-1', 'keep-2']);
      expect(results.map((r) => r.projectId).sort()).toEqual([1, 3]);
    });
  });

  describe('case 5: no-match case', () => {
    it('returns MatchResult with empty results array when nothing matches', async () => {
      const archive = await makeZip({
        '/src/foo.ts': 'no targets here',
      });

      getAllProjectsMock.mockResolvedValue([project({ id: 1, name: 'r' })]);
      getProjectArchiveMock.mockResolvedValue(archive);

      const results = await findStrings({
        searchStrings: ['NEVER_PRESENT'],
        branch: 'main',
      });

      expect(results).toHaveLength(1);
      expect(results[0].results).toEqual([]);
      expect(results[0].resultsLength).toBe(0);
    });
  });

  describe('case 6: onProgress callback', () => {
    it('fires callback once per project with (done, total, currentRepo)', async () => {
      const archive = await makeZip({ '/src/x.ts': 'X' });

      getAllProjectsMock.mockResolvedValue([
        project({ id: 1, name: 'alpha' }),
        project({ id: 2, name: 'beta' }),
        project({ id: 3, name: 'gamma' }),
      ]);
      getProjectArchiveMock.mockResolvedValue(archive);

      const calls: Array<[number, number, string]> = [];
      await findStrings({
        searchStrings: ['X'],
        branch: 'main',
        onProgress: (done, total, currentRepo) => {
          calls.push([done, total, currentRepo]);
        },
      });

      expect(calls).toHaveLength(3);
      // total is the same on every call
      expect(calls.every(([, total]) => total === 3)).toBe(true);
      // done increments 1-based, unique per project
      const dones = calls.map(([done]) => done).sort();
      expect(dones).toEqual([1, 2, 3]);
      // currentRepo matches one of the project names
      const repos = calls.map(([, , repo]) => repo).sort();
      expect(repos).toEqual(['alpha', 'beta', 'gamma']);
    });
  });

  describe('case 7: concurrency cap', () => {
    it('caps concurrent getProjectArchive calls to opts.concurrency (3, not default 5)', async () => {
      const archive = await makeZip({ '/src/x.ts': 'X' });

      const projectCount = 6;
      getAllProjectsMock.mockResolvedValue(
        Array.from({ length: projectCount }, (_, i) => project({ id: i + 1, name: `p${i}` })),
      );

      let active = 0;
      let peak = 0;
      getProjectArchiveMock.mockImplementation(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 40));
        active--;
        return archive;
      });

      await findStrings({
        searchStrings: ['X'],
        branch: 'main',
        concurrency: 3,
      });

      expect(peak).toBe(3);
      expect(peak).toBeLessThanOrEqual(3);
    });

    it('respects concurrency: 1 (sequential)', async () => {
      const archive = await makeZip({ '/src/x.ts': 'X' });

      const projectCount = 4;
      getAllProjectsMock.mockResolvedValue(
        Array.from({ length: projectCount }, (_, i) => project({ id: i + 1, name: `p${i}` })),
      );

      let active = 0;
      let peak = 0;
      getProjectArchiveMock.mockImplementation(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return archive;
      });

      await findStrings({
        searchStrings: ['X'],
        branch: 'main',
        concurrency: 1,
      });

      expect(peak).toBe(1);
    });

    it('uses concurrency 5 by default', async () => {
      const archive = await makeZip({ '/src/x.ts': 'X' });

      const projectCount = 6;
      getAllProjectsMock.mockResolvedValue(
        Array.from({ length: projectCount }, (_, i) => project({ id: i + 1, name: `p${i}` })),
      );

      let active = 0;
      let peak = 0;
      getProjectArchiveMock.mockImplementation(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 30));
        active--;
        return archive;
      });

      await findStrings({
        searchStrings: ['X'],
        branch: 'main',
        // no concurrency → default 5
      });

      // 6 projects with concurrency 5 → peak should reach 5 (not capped lower)
      expect(peak).toBe(5);
    });
  });

  describe('case 8: null-name project skipped', () => {
    it('skips projects with null or empty names', async () => {
      const archive = await makeZip({ '/src/x.ts': 'X' });

      getAllProjectsMock.mockResolvedValue([
        project({ id: 1, name: 'valid' }),
        project({ id: 2, name: null }),
        project({ id: 3, name: '' }),
        project({ id: 4, name: 'also-valid' }),
      ]);
      getProjectArchiveMock.mockResolvedValue(archive);

      const results = await findStrings({
        searchStrings: ['X'],
        branch: 'main',
      });

      expect(getProjectArchiveMock).toHaveBeenCalledTimes(2);
      expect(results.map((r) => r.projectName).sort()).toEqual(['also-valid', 'valid']);
      expect(results.map((r) => r.projectId).sort()).toEqual([1, 4]);
    });
  });

  // ---------- Additional coverage cases (for branch coverage) ----------

  describe('archive handling edge cases', () => {
    it('omits project from results when archive fetch returns null', async () => {
      getAllProjectsMock.mockResolvedValue([
        project({ id: 1, name: 'good' }),
        project({ id: 2, name: 'bad' }),
      ]);
      getProjectArchiveMock.mockImplementation(async (_id: number, opts?: { projectName?: string }) => {
        if (opts?.projectName === 'bad') return null;
        return await makeZip({ '/src/x.ts': 'X' });
      });

      const calls: Array<[number, number, string]> = [];
      const results = await findStrings({
        searchStrings: ['X'],
        branch: 'main',
        onProgress: (done, total, repo) => calls.push([done, total, repo]),
      });

      // Both projects still trigger onProgress (one success, one null)
      expect(calls).toHaveLength(2);
      // But only the good one shows up in results
      expect(results).toHaveLength(1);
      expect(results[0].projectName).toBe('good');
    });

    it('silently returns empty results when ZIP is malformed (findStrInZip catch)', async () => {
      getAllProjectsMock.mockResolvedValue([project({ id: 1, name: 'broken' })]);
      // Garbage bytes — not a valid ZIP
      getProjectArchiveMock.mockResolvedValue(new ArrayBuffer(8));

      const results = await findStrings({
        searchStrings: ['X'],
        branch: 'main',
      });

      expect(results).toHaveLength(1);
      expect(results[0].results).toEqual([]);
      expect(results[0].resultsLength).toBe(0);
    });
  });

  describe('search behaviour', () => {
    it('passes repoNameFilter to getAllProjects as empty string when omitted', async () => {
      const archive = await makeZip({ '/src/x.ts': 'X' });
      getAllProjectsMock.mockResolvedValue([project({ id: 1, name: 'r' })]);
      getProjectArchiveMock.mockResolvedValue(archive);

      await findStrings({
        searchStrings: ['X'],
        branch: 'main',
        // no repoNameFilter
      });

      expect(getAllProjectsMock).toHaveBeenCalledWith('');
    });

    it('passes explicit repoNameFilter to getAllProjects', async () => {
      const archive = await makeZip({ '/src/x.ts': 'X' });
      getAllProjectsMock.mockResolvedValue([project({ id: 1, name: 'r' })]);
      getProjectArchiveMock.mockResolvedValue(archive);

      await findStrings({
        searchStrings: ['X'],
        branch: 'main',
        repoNameFilter: 'frontend',
      });

      expect(getAllProjectsMock).toHaveBeenCalledWith('frontend');
    });

    it('passes branch to getProjectArchive for every project', async () => {
      const archive = await makeZip({ '/src/x.ts': 'X' });
      getAllProjectsMock.mockResolvedValue([
        project({ id: 1, name: 'a' }),
        project({ id: 2, name: 'b' }),
      ]);
      getProjectArchiveMock.mockResolvedValue(archive);

      await findStrings({
        searchStrings: ['X'],
        branch: 'feature/special',
      });

      expect(getProjectArchiveMock).toHaveBeenCalledTimes(2);
      expect(getProjectArchiveMock).toHaveBeenNthCalledWith(1, 1, {
        projectName: 'a',
        branch: 'feature/special',
      });
      expect(getProjectArchiveMock).toHaveBeenNthCalledWith(2, 2, {
        projectName: 'b',
        branch: 'feature/special',
      });
    });

    it('matches multiple search strings and reports which ones matched', async () => {
      const archive = await makeZip({
        '/src/a.ts': 'has ALPHA',
        '/src/b.ts': 'has BETA',
        '/src/c.ts': 'has both ALPHA and BETA',
      });

      getAllProjectsMock.mockResolvedValue([project({ id: 1, name: 'r' })]);
      getProjectArchiveMock.mockResolvedValue(archive);

      const results = await findStrings({
        searchStrings: ['ALPHA', 'BETA'],
        branch: 'main',
      });

      expect(results[0].results).toHaveLength(3);
      const byFile = Object.fromEntries(results[0].results.map((m) => [m.filename, m.matches]));
      expect(byFile['/src/a.ts']).toEqual(['ALPHA']);
      expect(byFile['/src/b.ts']).toEqual(['BETA']);
      expect(byFile['/src/c.ts']).toEqual(['ALPHA', 'BETA']);
    });

    it('does not call onProgress when not provided', async () => {
      const archive = await makeZip({ '/src/x.ts': 'X' });
      getAllProjectsMock.mockResolvedValue([project({ id: 1, name: 'r' })]);
      getProjectArchiveMock.mockResolvedValue(archive);

      // No onProgress in opts → must not throw
      await expect(
        findStrings({
          searchStrings: ['X'],
          branch: 'main',
        }),
      ).resolves.toHaveLength(1);
    });
  });

  describe('case 9: selectedRepos intersection filter', () => {
    it('searches only repos present (by id or name) in selectedRepos', async () => {
      const archive = await makeZip({ '/src/x.ts': 'X' });

      getAllProjectsMock.mockResolvedValue([
        project({ id: 1, name: 'keep-by-id' }),
        project({ id: 2, name: 'keep-by-name' }),
        project({ id: 3, name: 'drop-me' }),
      ]);
      getProjectArchiveMock.mockResolvedValue(archive);

      const results = await findStrings({
        searchStrings: ['X'],
        branch: 'main',
        selectedRepos: [
          { id: 1, name: 'keep-by-id' },     // matches by id
          { id: 999, name: 'keep-by-name' }, // matches by name (id differs)
        ],
      });

      expect(getProjectArchiveMock).toHaveBeenCalledTimes(2);
      expect(results.map((r) => r.projectName).sort()).toEqual(['keep-by-id', 'keep-by-name']);
    });

    it('applies excludeRepos first, then intersects with selectedRepos', async () => {
      const archive = await makeZip({ '/src/x.ts': 'X' });

      getAllProjectsMock.mockResolvedValue([
        project({ id: 1, name: 'excluded' }),
        project({ id: 2, name: 'selected' }),
        project({ id: 3, name: 'neither' }),
      ]);
      getProjectArchiveMock.mockResolvedValue(archive);

      const results = await findStrings({
        searchStrings: ['X'],
        branch: 'main',
        excludeRepos: ['excluded'],
        selectedRepos: [{ id: 2, name: 'selected' }],
      });

      // 'excluded' dropped by excludeRepos; only 'selected' in the intersection.
      expect(getProjectArchiveMock).toHaveBeenCalledTimes(1);
      expect(results.map((r) => r.projectName)).toEqual(['selected']);
    });

    it('returns [] without fetching any archive when selectedRepos matches nothing', async () => {
      getAllProjectsMock.mockResolvedValue([
        project({ id: 1, name: 'only-one' }),
      ]);
      getProjectArchiveMock.mockResolvedValue(null);

      const results = await findStrings({
        searchStrings: ['X'],
        branch: 'main',
        selectedRepos: [{ id: 999, name: 'does-not-exist' }],
      });

      expect(getProjectArchiveMock).not.toHaveBeenCalled();
      expect(results).toEqual([]);
    });

    it('keeps legacy behaviour (all repos) when selectedRepos is undefined', async () => {
      const archive = await makeZip({ '/src/x.ts': 'X' });

      getAllProjectsMock.mockResolvedValue([
        project({ id: 1, name: 'a' }),
        project({ id: 2, name: 'b' }),
      ]);
      getProjectArchiveMock.mockResolvedValue(archive);

      const results = await findStrings({
        searchStrings: ['X'],
        branch: 'main',
        // no selectedRepos
      });

      expect(getProjectArchiveMock).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(2);
    });
  });

  describe('case 10: pre-loaded projects option', () => {
    it('does NOT call getAllProjects when projects is provided', async () => {
      const archive = await makeZip({ '/src/x.ts': 'X' });
      getProjectArchiveMock.mockResolvedValue(archive);

      const results = await findStrings({
        searchStrings: ['X'],
        branch: 'main',
        projects: [project({ id: 1, name: 'preloaded', description: 'Desc' })],
      });

      expect(getAllProjectsMock).not.toHaveBeenCalled();
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        projectId: 1,
        projectName: 'preloaded',
        projectDescription: 'Desc',
      });
    });

    it('ignores repoNameFilter for the fetch when projects is provided', async () => {
      const archive = await makeZip({ '/src/x.ts': 'X' });
      getProjectArchiveMock.mockResolvedValue(archive);

      await findStrings({
        searchStrings: ['X'],
        branch: 'main',
        repoNameFilter: 'frontend',
        projects: [project({ id: 1, name: 'preloaded' })],
      });

      expect(getAllProjectsMock).not.toHaveBeenCalled();
    });

    it('applies excludeRepos and selectedRepos on top of provided projects', async () => {
      const archive = await makeZip({ '/src/x.ts': 'X' });
      getProjectArchiveMock.mockResolvedValue(archive);

      const results = await findStrings({
        searchStrings: ['X'],
        branch: 'main',
        projects: [
          project({ id: 1, name: 'keep' }),
          project({ id: 2, name: 'excluded' }),
          project({ id: 3, name: 'dropped-by-selected' }),
        ],
        excludeRepos: ['excluded'],
        selectedRepos: [{ id: 1, name: 'keep' }],
      });

      expect(results.map((r) => r.projectName)).toEqual(['keep']);
    });
  });
});
