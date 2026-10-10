import { describe, it, expect, vi } from 'vitest';
import { repoSelect, type RepoSelectPrompt } from '../repo-select.ts';
import type { RepoInfo } from '@gitlab-analyzer/core';

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

  it('case 52: enquirerRepoSelect builds the multiselect with limit: 50 (viewport, not a selection cap)', async () => {
    // Pin the prompt shape: `limit` is enquirer's viewport height — more than
    // 50 repos remain fully selectable via scrolling. Mock Enquirer.prompt to
    // capture the options object without opening a TTY.
    const { enquirerRepoSelect } = await import('../repo-select.ts');
    const Enquirer = (await import('enquirer')).default;
    // Answers use choice NAMES; only names present in `repos` map back.
    const promptSpy = vi.spyOn(Enquirer, 'prompt').mockResolvedValue({
      repos: ['repo-1', 'repo-2', 'repo-60'],
    });

    const repos: RepoInfo[] = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      name: `repo-${i + 1}`,
    }));

    const selected = await enquirerRepoSelect(repos);

    expect(promptSpy).toHaveBeenCalledTimes(1);
    const options = promptSpy.mock.calls[0][0] as unknown as {
      type: string;
      choices: Array<{ name: string }>;
      initial: string[];
      limit: number;
    };
    expect(options.type).toBe('multiselect');
    // All 60 repos are in the choice list (limit only affects rendering).
    expect(options.choices).toHaveLength(60);
    // All 60 pre-selected via initial.
    expect(options.initial).toHaveLength(60);
    // Viewport pinned at 50.
    expect(options.limit).toBe(50);

    // Selection maps names back to full RepoInfo objects, in answer order.
    expect(selected.map((r) => r.name)).toEqual(['repo-1', 'repo-2', 'repo-60']);

    promptSpy.mockRestore();
  });
});
