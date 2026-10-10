import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Hoisted module mocks (same pattern as src/api/__tests__/repository-tree.test.ts).
 * The config module is `../config.ts` (one level up from `__tests__/` into
 * `src/api/`), matching the import specifier used inside `../commits.ts`.
 */
const { axiosGetMock } = vi.hoisted(() => ({
  axiosGetMock: vi.fn(),
}));

vi.mock('../config.ts', () => ({
  axiosInstance: { get: axiosGetMock },
}));

import { getCommits } from '../commits.ts';
import type { Commit } from '../../types.ts';

function commit(shortId: string): Commit {
  return {
    id: `sha-${shortId}`,
    short_id: shortId,
    title: `Commit ${shortId}`,
    message: `commit message ${shortId}`,
    author_name: 'Jane Doe',
    author_email: 'jane@example.com',
    authored_date: '2026-01-02T10:00:00.000Z',
    committer_name: 'Jane Doe',
    committer_email: 'jane@example.com',
    committed_date: '2026-01-02T10:00:00.000Z',
    parent_ids: [],
    web_url: `https://gitlab.example.com/repo/-/commit/${shortId}`,
  };
}

describe('getCommits', () => {
  beforeEach(() => {
    axiosGetMock.mockReset();
  });

  it('case 1: successful response maps to Commit[]', async () => {
    const expected = [commit('abc1234'), commit('def5678')];
    axiosGetMock.mockResolvedValueOnce({ data: expected, status: 200 });

    const result = await getCommits(42, { ref_name: 'develop' });

    expect(result).toEqual(expected);
    expect(axiosGetMock).toHaveBeenCalledWith(
      '/api/v4/projects/42/repository/commits',
      expect.objectContaining({ params: { ref_name: 'develop' } }),
    );
  });

  it('case 2: HTTP error is thrown with its message (never swallowed into null)', async () => {
    axiosGetMock.mockRejectedValueOnce(new Error('Request failed with status code 404'));

    await expect(getCommits(42, { ref_name: 'develop' })).rejects.toThrow(
      'Request failed with status code 404',
    );
  });

  it('case 3: timeout cause is normalized into a human-readable message', async () => {
    axiosGetMock.mockRejectedValueOnce(
      Object.assign(new Error('canceled'), { cause: { name: 'TimeoutError' } }),
    );

    await expect(getCommits(1, { ref_name: 'main' })).rejects.toThrow(
      'commits request timed out (60s)',
    );
  });

  it('case 4: per_page and path are passed through as query params', async () => {
    axiosGetMock.mockResolvedValueOnce({ data: [], status: 200 });

    await getCommits(7, { path: 'src/a.ts', ref_name: 'main', per_page: 1 });

    expect(axiosGetMock).toHaveBeenCalledWith(
      '/api/v4/projects/7/repository/commits',
      expect.objectContaining({
        params: { path: 'src/a.ts', ref_name: 'main', per_page: 1 },
      }),
    );
  });
});
