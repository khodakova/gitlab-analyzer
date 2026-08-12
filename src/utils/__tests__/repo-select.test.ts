import { describe, it, expect, vi } from 'vitest';
import { repoSelect, type RepoSelectPrompt } from '../repo-select.ts';
import type { RepoInfo } from '../../types.ts';

describe('repoSelect', () => {
  it('injects the prompt and returns its result untouched', async () => {
    const repos: RepoInfo[] = [
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
    ];
    const selected: RepoInfo[] = [{ id: 1, name: 'alpha' }];
    const fakePrompt: RepoSelectPrompt = vi.fn().mockResolvedValue(selected);

    const result = await repoSelect(repos, fakePrompt);

    expect(fakePrompt).toHaveBeenCalledTimes(1);
    expect(fakePrompt).toHaveBeenCalledWith(repos);
    expect(result).toBe(selected);
    expect(result).toEqual([{ id: 1, name: 'alpha' }]);
  });

  it('returns an empty array when the injected prompt selects nothing', async () => {
    const repos: RepoInfo[] = [{ id: 9, name: 'solo' }];
    const fakePrompt: RepoSelectPrompt = vi.fn().mockResolvedValue([]);

    const result = await repoSelect(repos, fakePrompt);

    expect(result).toEqual([]);
  });
});
