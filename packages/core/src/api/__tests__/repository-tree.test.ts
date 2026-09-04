import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Hoisted module mocks (same pattern as src/commands/__tests__/find-matches.test.ts).
 * This file lives at `src/api/__tests__/`, so the config module is `../config.ts`
 * (one level up from `__tests__/` into `src/api/`) and the logger is
 * `../../utils/logger.ts` — matching the import specifiers used inside
 * `../repository-tree.ts` (`./config.ts`, `../utils/logger.ts`).
 */
const { axiosGetMock, warnMock } = vi.hoisted(() => ({
  axiosGetMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('../config.ts', () => ({
  axiosInstance: { get: axiosGetMock },
}));

vi.mock('../../utils/logger.ts', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
  },
}));

import { listRepoTreeRecursive } from '../repository-tree.ts';
import type { TreeEntry } from '../repository-tree.ts';

function entry(path: string, type: 'blob' | 'tree' = 'blob'): TreeEntry {
  return {
    id: `id-${path}`,
    name: path.split('/').pop() ?? path,
    type,
    path,
    mode: '100644',
  };
}

/** Minimal axios-like response for the mocked `axiosInstance.get`. */
function page(entries: TreeEntry[], nextPage?: string | string[]) {
  return {
    data: entries,
    headers: nextPage === undefined ? {} : { 'x-next-page': nextPage },
    status: 200,
  };
}

describe('listRepoTreeRecursive', () => {
  beforeEach(() => {
    axiosGetMock.mockReset();
    warnMock.mockReset();
  });

  it('case 1: first request sends exactly recursive/per_page=100/ref and page=1, no keyset params', async () => {
    axiosGetMock.mockResolvedValueOnce(page([entry('src/a.ts')]));

    const result = await listRepoTreeRecursive(42, 'develop', { projectName: 'repo-a' });

    expect(axiosGetMock).toHaveBeenCalledTimes(1);
    expect(axiosGetMock).toHaveBeenCalledWith('/api/v4/projects/42/repository/tree', {
      params: { recursive: 'true', per_page: 100, ref: 'develop', page: 1 },
    });
    expect(result).toEqual({ entries: [entry('src/a.ts')], truncated: false });
  });

  it('case 2: follows x-next-page header into page 2, concatenates entries, truncated=false', async () => {
    axiosGetMock
      .mockResolvedValueOnce(page([entry('src/a.ts'), entry('src/b.ts')], '2'))
      .mockResolvedValueOnce(page([entry('lib/c.ts')]));

    const result = await listRepoTreeRecursive(1, 'main');

    expect(axiosGetMock).toHaveBeenCalledTimes(2);
    expect(axiosGetMock).toHaveBeenNthCalledWith(2, '/api/v4/projects/1/repository/tree', {
      params: { recursive: 'true', per_page: 100, ref: 'main', page: 2 },
    });
    expect(result.entries.map((e) => e.path)).toEqual(['src/a.ts', 'src/b.ts', 'lib/c.ts']);
    expect(result.truncated).toBe(false);
  });

  it('case 3: no x-next-page header → single request and stop', async () => {
    axiosGetMock.mockResolvedValue(page([entry('README.md')]));

    const result = await listRepoTreeRecursive(1, 'main');

    expect(axiosGetMock).toHaveBeenCalledTimes(1);
    expect(result.entries).toHaveLength(1);
    expect(result.truncated).toBe(false);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('case 4: 101st page exists → stops after exactly 100 requests, truncated=true, warns', async () => {
    let callCount = 0;
    axiosGetMock.mockImplementation(async () => {
      callCount++;
      // Every page advertises another next page — the loop must still stop
      // at MAX_TREE_PAGES=100 and never request a 101st page.
      return page([entry(`f${callCount}.ts`)], String(callCount + 1));
    });

    const result = await listRepoTreeRecursive(1, 'main');

    expect(callCount).toBe(100);
    expect(axiosGetMock).toHaveBeenCalledTimes(100);
    expect(result.entries).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(String(warnMock.mock.calls[0][0])).toContain('truncated');
  });

  it('case 5: last page returns empty x-next-page → stops', async () => {
    axiosGetMock
      .mockResolvedValueOnce(page([entry('a.ts')], '2'))
      .mockResolvedValueOnce(page([entry('b.ts')], ''));

    const result = await listRepoTreeRecursive(1, 'main');

    expect(axiosGetMock).toHaveBeenCalledTimes(2);
    expect(result.entries.map((e) => e.path)).toEqual(['a.ts', 'b.ts']);
    expect(result.truncated).toBe(false);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('case 6: axios 404 → promise rejects with a message containing 404', async () => {
    axiosGetMock.mockRejectedValue(new Error('Request failed with status code 404'));

    await expect(listRepoTreeRecursive(7, 'main')).rejects.toThrow('404');
  });

  it('case 7: exactly MAX_TREE_PAGES pages with no next header on the last page → truncated false, no pagination warn', async () => {
    let callCount = 0;
    axiosGetMock.mockImplementation(async () => {
      callCount++;
      // Pages 1..99 advertise a next page; page 100 is the last one and has none.
      const next = callCount < 100 ? String(callCount + 1) : undefined;
      return page([entry(`f${callCount}.ts`)], next);
    });

    const result = await listRepoTreeRecursive(1, 'main');

    expect(callCount).toBe(100);
    expect(axiosGetMock).toHaveBeenCalledTimes(100);
    expect(result.entries).toHaveLength(100);
    expect(result.truncated).toBe(false);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('regression: page 1 all trees with x-next-page → blob package.json on page 2 is found', async () => {
    const trees = Array.from({ length: 100 }, (_, i) => entry(`dir-${i}`, 'tree'));
    axiosGetMock
      .mockResolvedValueOnce(page(trees, '2'))
      .mockResolvedValueOnce(page([entry('package.json')]));

    const result = await listRepoTreeRecursive(1, 'develop');

    expect(axiosGetMock).toHaveBeenCalledTimes(2);
    expect(result.entries.some((e) => e.path === 'package.json' && e.type === 'blob')).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('normalizes x-next-page delivered as an array (takes the first element)', async () => {
    axiosGetMock
      .mockResolvedValueOnce(page([entry('a.ts')], ['2']))
      .mockResolvedValueOnce(page([entry('b.ts')]));

    const result = await listRepoTreeRecursive(1, 'main');

    expect(axiosGetMock).toHaveBeenCalledTimes(2);
    expect(axiosGetMock).toHaveBeenNthCalledWith(2, '/api/v4/projects/1/repository/tree', {
      params: expect.objectContaining({ page: 2 }),
    });
    expect(result.truncated).toBe(false);
  });
});
