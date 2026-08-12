# Interactive Repository Selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `--interactive` flag to `find-strings` so a user can deselect repos (space) from an all-selected list before the search runs, plus always print the resolved repo list to stderr before searching (headless), using `enquirer` and exposing `selectedRepos` on `findStrings`.

**Architecture:** Add a shared, prompt-injected `repoSelect` util in the CLI layer; extend `findStrings` with a `selectedRepos: {id,name}[]` intersection filter; wire the `--interactive` flag + stub `report()` output layer into `cli.ts`. `findStrings` stays pure (no console/process calls).

**Tech Stack:** Node ≥20, TypeScript, Vitest, CLI via `commander`, prompts via `enquirer` (2.4.1, ships own `index.d.ts`), tsup build.

## Global Constraints

- Type-error suppression (`as any`, `@ts-ignore`, `@ts-expect-error`) is forbidden.
- `findStrings` must stay pure: no `console.*`, no `process.exit`, no file writes.
- Progress/errors/summaries always go to **stderr** (stdout JSON must stay pipeable).
- Empty interactive selection = **silent-ish cancel**: message to stderr + `process.exit(0)`, no search.
- Interactive mode must NOT print the headless stderr repo list (it's visible in the picker).
- Language/labels for user-facing messages follow the existing style (Russian/English mix as in `get-projects.ts`/README). Existing stderr lines use English; keep new visible messages consistent with surrounding output.
- Tests follow the existing `vi.hoisted` + `vi.mock` pattern (see `src/commands/__tests__/find-strings.test.ts` and `src/cli/__tests__/cli.test.ts`).
- Doc updates (README + commander help) are part of this work.
- `enquirer` must be added to `dependencies` (already present transitively via changesets, but must be a real prod dependency + pinned version `^2.4.1`).

---
---

### Task 1: Add `RepoInfo` type + `enquirer` dependency

**Files:**
- Modify: `src/types.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `RepoInfo = { id: number; name: string }` (exported from `src/types.ts`) used by Tasks 2, 3, 4.

- [ ] **Step 1:** Add the `RepoInfo` type to `src/types.ts` (append at the bottom):

```ts
/**
 * Lightweight identifier for a single GitLab project, used when the caller
 * wants to narrow a search to a specific subset of repositories (e.g. the
 * `selectedRepos` option of `findStrings` or the interactive picker).
 */
export type RepoInfo = {
  /** GitLab project ID. */
  id: number;
  /** Project name as returned by GitLab. Always non-null on the paths that build RepoInfo. */
  name: string;
};
```

- [ ] **Step 2:** Add `enquirer` to `package.json` `dependencies`:

```json
"dotenv": "17.4.2",
"enquirer": "^2.4.1",
"jszip": "3.10.1",
```

- [ ] **Step 3:** Install to update the lockfile: run `yarn install` (or `yarn add enquirer@^2.4.1`). Expected: `enquirer@2.4.1` appears in `dependencies` and `yarn.lock`.

- [ ] **Step 4:** Typecheck: run `yarn build:types`. Expected: exit 0, no new errors.

- [ ] **Step 5:** Commit (requires explicit user approval before running):

```bash
git add src/types.ts package.json yarn.lock
git commit -m "feat: add RepoInfo type and enquirer dependency"
```

---
---

### Task 2: Shared `repoSelect` utility with prompt injection

**Files:**
- Create: `src/utils/repo-select.ts`
- Test: `src/utils/__tests__/repo-select.test.ts`

**Interfaces:**
- Consumes: `RepoInfo` from `../types.ts`; `Enquirer` from `enquirer`.
- Produces:
  ```ts
  export type RepoSelectPrompt = (repos: readonly RepoInfo[]) => Promise<RepoInfo[]>;
  export const enquirerRepoSelect: RepoSelectPrompt;
  export async function repoSelect(repos: readonly RepoInfo[], prompt?: RepoSelectPrompt): Promise<RepoInfo[]>;
  ```
  (used by Task 4 in `cli.ts`)

- [ ] **Step 1: Write the failing test** — `src/utils/__tests__/repo-select.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run src/utils/__tests__/repo-select.test.ts`
Expected: FAIL — `Cannot find module '../repo-select.ts'`.

- [ ] **Step 3: Write the implementation** — `src/utils/repo-select.ts`:

```ts
import Enquirer from 'enquirer';
import type { RepoInfo } from '../types.ts';

/**
 * A function that asks the user to pick a subset of repositories.
 *
 * Injected so tests can substitute a fake without opening a real TTY. The
 * default {@link enquirerRepoSelect} renders an `enquirer` `multiselect`
 * (all repos preselected; space toggles one; Enter confirms) and returns the
 * chosen `RepoInfo` entries.
 */
export type RepoSelectPrompt = (repos: readonly RepoInfo[]) => Promise<RepoInfo[]>;

/**
 * Default prompt implementation backed by `enquirer`'s `multiselect`.
 *
 * @param repos - Repositories to choose from (already filtered by `excludeRepos`
 *   upstream — see `cli.ts`). Every repo starts selected.
 * @returns The selected subset of `repos`.
 */
export const enquirerRepoSelect: RepoSelectPrompt = async (repos) => {
  // `Enquirer.prompt({ ... })` with a single question object resolves to
  // `{ [name]: value }` (an object keyed by the question `name`), and a
  // `multiselect` resolves to the array of SELECTED CHOICE NAMES (not the
  // choice `value`). So we read `answers.repos` (the `string[]` of names)
  // and map them back to the full `RepoInfo` objects from `repos`.
  const answers = await Enquirer.prompt<{ repos: string[] }>({
    type: 'multiselect',
    name: 'repos',
    message: 'Выберите репозитории, по которым будет выполнен поиск (пробел — отметить/снять, Enter — подтвердить)',
    choices: repos.map((repo) => ({
      name: repo.name,
      enabled: true,
    })),
    limit: 10,
  });

  const selectedNames = answers.repos;
  if (!Array.isArray(selectedNames)) {
    return [];
  }
  const byName = new Map(repos.map((repo) => [repo.name, repo]));
  return selectedNames
    .map((name) => byName.get(name))
    .filter((repo): repo is RepoInfo => repo !== undefined);
};

/**
 * Ask the user to pick a subset of repositories, calling {@link prompt}
 * (defaults to {@link enquirerRepoSelect}) with the full list.
 *
 * Pure — no console output, no `process.exit`. Return `[]` when the user
 * selects nothing; the caller decides how to handle that (see `cli.ts`).
 *
 * @param repos - Repositories to choose from.
 * @param prompt - Prompt function; only injected in tests.
 */
export async function repoSelect(
  repos: readonly RepoInfo[],
  prompt: RepoSelectPrompt = enquirerRepoSelect,
): Promise<RepoInfo[]> {
  return prompt(repos);
}
```

  Note: a `multiselect` returns the selected **choice names** (by default —
  even when a `value` is set), and `Enquirer.prompt(obj)` resolves to
  `{ [name]: value }`. So we read `answers.repos` (a `string[]` of names) and
  map back to `RepoInfo` via `byName`. When nothing is selected, enquirer
  resolves `repos` to an empty array — but defensively we treat any non-array
  as `[]` (see guard). The prompt-injection tests in Step 1 never touch enquirer,
  so they stay hermetic.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run src/utils/__tests__/repo-select.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck**

Run: `yarn build:types`
Expected: exit 0.

- [ ] **Step 6: Commit** (approval first):

```bash
git add src/utils/repo-select.ts src/utils/__tests__/repo-select.test.ts
git commit -m "feat: add shared repoSelect util with prompt injection"
```

---
---

### Task 3: `selectedRepos` intersection filter on `findStrings`

**Files:**
- Modify: `src/commands/find-strings.ts`
- Test: `src/commands/__tests__/find-strings.test.ts`

**Interfaces:**
- Consumes: `RepoInfo` from `../types.ts` (Task 1).
- Produces: `selectedRepos?: readonly RepoInfo[]` field on `FindStringsOptions` (consumed by Task 4).

- [ ] **Step 1: Write the failing tests** — append a new `describe` block inside
  `src/commands/__tests__/find-strings.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn vitest run src/commands/__tests__/find-strings.test.ts -t "selectedRepos"`
Expected: FAIL — `FindStringsOptions` has no `selectedRepos`.

- [ ] **Step 3: Implement** — in `src/commands/find-strings.ts`, import `RepoInfo` and extend the type + filter:

  Import line (extend existing types import):
```ts
import type { SearchProjectsItem, RepoInfo } from '../types.ts';
```

  Add a field to `FindStringsOptions` (after `excludeRepos`):
```ts
  /**
   * Optional explicit allowlist of repositories to search. When provided,
   * only projects whose `id` OR `name` matches an entry are scanned. Applied
   * AFTER `excludeRepos` (intersection). Omit (or `undefined`) to keep the
   * legacy behaviour: search every project not excluded by `excludeRepos`.
   */
  selectedRepos?: readonly RepoInfo[];
```

  In the body of `findStrings`, read it and extend the project filter:
```ts
  const excludeRepos = opts.excludeRepos ?? [];
  const selectedRepos = opts.selectedRepos;

  const allProjects = await getAllProjects(opts.repoNameFilter ?? '');
  const projects = allProjects.filter(
    (project): project is SearchProjectsItem & { name: string } =>
      project.name !== null &&
      project.name.length > 0 &&
      !excludeRepos.includes(project.name) &&
      (selectedRepos === undefined ||
        selectedRepos.some(
          (s) => s.id === project.id || s.name === project.name,
        )),
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn vitest run src/commands/__tests__/find-strings.test.ts`
Expected: PASS — all existing cases + 4 new selectedRepos cases.

- [ ] **Step 5: Typecheck**

Run: `yarn build:types`
Expected: exit 0.

- [ ] **Step 6: Commit** (approval first):

```bash
git add src/commands/find-strings.ts src/commands/__tests__/find-strings.test.ts
git commit -m "feat: add selectedRepos intersection filter to findStrings"
```

---
---

### Task 4: Wire `--interactive` + `report()` into the CLI

**Files:**
- Modify: `src/cli.ts`
- Test: `src/cli/__tests__/cli.test.ts`
- Modify: `src/index.ts` (re-export `RepoInfo` type)

**Interfaces:**
- Consumes: `repoSelect` from `./utils/repo-select.ts`; `RepoInfo` from `./types.ts`; `selectedRepos` option from `./commands/find-strings.ts` (Task 3).
- Produces:
  - New `report(line: string): void` (CLI-local, used for all stderr output).
  - `FindStringsCliOptions.interactive?: boolean`.
  - `runFindStrings` behaviour: when `interactive` is true, fetch the repo list first, run the picker, and (a) exit 0 on empty selection, (b) pass `selectedRepos` to `findStrings`.

- [ ] **Step 1: Write failing tests** — extend `src/cli/__tests__/cli.test.ts`:

  Inside the existing `cli > buildProgram` describe block, add mock for the util
  at the top (near the existing `mocks` object):

```ts
const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  findStrings: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  repoSelect: vi.fn(),
}));
```

  Add a matching `vi.mock` near the others:

```ts
vi.mock('../../utils/repo-select.ts', () => ({
  repoSelect: mocks.repoSelect,
  enquirerRepoSelect: vi.fn(),
}));
```

  Add `--interactive` to the `--help` test assertion (in the existing
  `'--help on find-strings subcommand'` describe, first `it`):

```ts
      expect(out).toContain('--concurrency');
      expect(out).toContain('--interactive');
```

  Add a new describe block (place after the `'end-to-end mocked run'` block):

```ts
  describe('--interactive with repo selection', () => {
    beforeEach(() => {
      mocks.loadConfig.mockReset();
      mocks.findStrings.mockReset();
      mocks.repoSelect.mockReset();
    });

    it('does NOT call repoSelect (headless) when --interactive is absent', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.findStrings.mockResolvedValue([]);
      mocks.writeFile.mockResolvedValue(undefined);
      // getAllProjects is not exported from cli; we assert via findStrings opts only.
      // Pre-set repoSelect so if it WERE called the test would catch it.
      mocks.repoSelect.mockResolvedValue([]);

      const program = buildProgram();
      await program.parseAsync([
        'node', 'gitlab-analyzer', 'find-strings', 'needle',
        '--output', path.join(os.tmpdir(), 'headless.json'),
      ]);

      expect(mocks.repoSelect).not.toHaveBeenCalled();
    });

    it('runs the picker and passes selectedRepos to findStrings when --interactive', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.findStrings.mockResolvedValue([]);
      mocks.writeFile.mockResolvedValue(undefined);
      mocks.repoSelect.mockResolvedValue([
        { id: 1, name: 'alpha' },
        { id: 2, name: 'beta' },
      ]);

      const program = buildProgram();
      await program.parseAsync([
        'node', 'gitlab-analyzer', 'find-strings', 'needle', '--interactive',
        '--output', path.join(os.tmpdir(), 'interactive.json'),
      ]);

      expect(mocks.repoSelect).toHaveBeenCalledTimes(1);
      expect(mocks.findStrings).toHaveBeenCalledTimes(1);
      const passedOpts = mocks.findStrings.mock.calls[0][0];
      expect(passedOpts.selectedRepos).toEqual([
        { id: 1, name: 'alpha' },
        { id: 2, name: 'beta' },
      ]);
    });

    it('cancels (exit 0, no search, message to stderr) when the user selects nothing', async () => {
      mocks.loadConfig.mockResolvedValue(defaultConfig());
      mocks.findStrings.mockResolvedValue([]);
      mocks.writeFile.mockResolvedValue(undefined);
      mocks.repoSelect.mockResolvedValue([]);

      const program = buildProgram();

      // Commander with exitOverride throws on process.exit(0); catch it.
      await program
        .parseAsync([
          'node', 'gitlab-analyzer', 'find-strings', 'needle', '--interactive',
          '--output', path.join(os.tmpdir(), 'cancel.json'),
        ])
        .catch((e: unknown) => {
          if (e instanceof Error && e.message === 'process.exit(0)') return;
          throw e;
        });

      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(mocks.findStrings).not.toHaveBeenCalled();
      const stderrText = collectWriteCalls(stderrSpy);
      expect(stderrText).toMatch(/поиск|репозитори|cancel|отмен|ничего/i);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn vitest run src/cli/__tests__/cli.test.ts`
Expected: FAIL — `--interactive` not registered; `repoSelect` not wired; no exit-0 cancel.

- [ ] **Step 3: Implement `report` + imports** in `src/cli.ts`:

  Add imports (after existing `findStrings` import block):
```ts
import { repoSelect } from './utils/repo-select.ts';
import type { RepoInfo } from './types.ts';
```

  Add a module-level JSDoc note and the `report` helper near the top of the
  file (after the imports, before `FindStringsCliOptions`):

```ts
/**
 * Thin output helper for CLI-level lines that must always go to stderr
 * (progress, summaries, errors, the pre-search repo list). Kept behind one
 * function so a future `--enable-logs` flag can add verbosity levels without
 * touching every call site.
 */
function report(line: string): void {
  process.stderr.write(`${line}\n`);
}
```

- [ ] **Step 4: Add `interactive` to the CLI options type and resolve plumbing**

  Extend `FindStringsCliOptions`:
```ts
export type FindStringsCliOptions = {
  repoFilter?: string;
  exclude?: string[];
  branch?: string;
  pathFilter?: string;
  includeTests?: boolean;
  output?: string;
  concurrency?: number;
  interactive?: boolean;
};
```

  Add the field to `ResolvedFindStringsOptions`:
```ts
  /** Whether to prompt the user to pick repos before searching. */
  interactive: boolean;
```

  Populate it in `resolveOptions` (default `false` — headless by default):
```ts
    output: cliOpts.output ?? cmdDefaults?.output,
    interactive: cliOpts.interactive ?? false,
```

- [ ] **Step 5: Register the flag in `buildProgram`**:

```ts
    .option('--include-tests', 'Include *.test.* files in the search')
    .option(
      '--interactive',
      'Let you choose which repositories to search (space toggles a repo, Enter confirms); empty selection cancels',
    )
    .option('-o, --output <path>', 'Path to write JSON results; omit to write to stdout')
```

- [ ] **Step 6: Wire interactive selection into `runFindStrings`**

  Current signature stays. Inside `runFindStrings`, after `const { resolved } = resolution;` and after setting
  `axiosInstance.defaults.baseURL`, add a `selectedRepos` resolution step:

```ts
  // Interactive repo selection: fetch the (already excludeRepos-filtered)
  // project list, let the user deselect repos, and narrow the search to the
  // chosen subset. An empty selection means "cancel" — exit 0 without searching.
  let selectedRepos: RepoInfo[] | undefined;
  if (resolved.interactive) {
    const allProjects = await getAllProjects(resolved.repoNameFilter);
    // Mirror findStrings' filtering so the picker shows exactly what will be searched.
    const excludeList = resolved.excludeRepos;
    const filtered = allProjects.filter(
      (p) => p.name !== null && p.name.length > 0 && !excludeList.includes(p.name),
    );
    const repos: RepoInfo[] = filtered.map((p) => ({
      id: p.id,
      name: p.name as string,
    }));

    selectedRepos = await repoSelect(repos);

    if (selectedRepos.length === 0) {
      report('Поиск отменён: не выбрано ни одного репозитория.');
      process.exit(0);
    }
  }
```

  Add `getAllProjects` import:
```ts
import { getAllProjects } from './utils/get-projects.ts';
```

  Pass `selectedRepos` into `findOpts`:
```ts
  const findOpts: FindStringsOptions = {
    searchStrings: strings,
    branch: resolved.branch,
    repoNameFilter: resolved.repoNameFilter,
    excludeRepos: resolved.excludeRepos,
    selectedRepos,
    pathFilter: resolved.pathFilter,
    includeTests: resolved.includeTests,
    concurrency: resolved.concurrency,
    onProgress: (done, total, currentRepo) => {
      report(`[${done}/${total}] ${currentRepo}`);
    },
  };
```

- [ ] **Step 7: Headless repo-list output to stderr**

  Still inside `runFindStrings`, only when NOT interactive, print the resolved
  repo list for information. Put this AFTER computing `selectedRepos` (so the
  non-interactive branch runs it) and right BEFORE calling `findStrings`:

```ts
  if (!resolved.interactive) {
    const allProjects = await getAllProjects(resolved.repoNameFilter);
    const excludeList = resolved.excludeRepos;
    const filtered = allProjects.filter(
      (p) => p.name !== null && p.name.length > 0 && !excludeList.includes(p.name),
    );
    report(`Будет выполнен поиск по ${filtered.length} репозиториям:`);
    for (const p of filtered) {
      report(p.name as string);
    }
  }
```

  Note: this duplicates the fetch + filter that `findStrings` does internally.
  That's acceptable and keeps `findStrings` pure; the cost is one extra
  projects-list fetch in headless mode. Do NOT "optimize" this by moving the
  fetch/print into `findStrings` — that would break the library-purity rule
  (no `console.*`, no `process.exit`). To avoid the need to mock
  `getAllProjects` twice, tests for the headless list output should assert the
  `report`/stderr content by invoking `runFindStrings` (not `buildProgram`) and
  providing a real-ish flow. See Step 8.

- [ ] **Step 8: Test the headless repo-list output via `runFindStrings`**

  Add to `src/cli/__tests__/cli.test.ts` — in the `cli > runFindStrings` describe,
  add mocks for `getAllProjects`:

```ts
const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  findStrings: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  repoSelect: vi.fn(),
  getAllProjects: vi.fn(),
}));
```

  And a `vi.mock`:
```ts
vi.mock('../../utils/get-projects.ts', () => ({
  getAllProjects: mocks.getAllProjects,
}));
```

  In `beforeEach` add `mocks.getAllProjects.mockReset();`.

  Then a new `it` block in the `cli > runFindStrings` describe:

```ts
  it('prints the resolved repo list to stderr in headless mode', async () => {
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.getAllProjects.mockResolvedValue([
      { id: 1, name: 'alpha', description: null },
      { id: 2, name: 'beta', description: null },
      { id: 3, name: 'skip', description: null },
    ]);
    mocks.findStrings.mockImplementation(async (opts) => {
      // Mirror findStrings' exclusion so defaultConfig excludeRepos=[] keeps all.
      void opts;
      return [];
    });
    mocks.writeFile.mockResolvedValue(undefined);

    const result = await runFindStrings(['x'], {});

    const stderrText = collectWriteCalls(stderrSpy);
    expect(stderrText).toContain('Будет выполнен поиск по 3 репозиториям:');
    expect(stderrText).toContain('alpha');
    expect(stderrText).toContain('beta');
    expect(stderrText).toContain('skip');
    expect(result.outputPath).toBeUndefined();
  });
```

- [ ] **Step 9: Re-export `RepoInfo` from the public barrel**

  In `src/index.ts`, add to the type re-exports:

```ts
export type { RepoInfo } from './types.ts';
```

- [ ] **Step 10: Run all tests**

Run: `yarn test`
Expected: PASS.

- [ ] **Step 11: Typecheck + build**

Run: `yarn build:types` then `yarn build`
Expected: exit 0 on both; `dist/cli.js` and `dist/index.js` regenerate.

- [ ] **Step 12: Commit** (approval first):

```bash
git add src/cli.ts src/index.ts src/cli/__tests__/cli.test.ts
git commit -m "feat: add --interactive repo selection and stderr repo-list output"
```

---
---

### Task 5: Documentation (README)

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: none.
- Produces: docs describing `--interactive`, `selectedRepos`, and the new stderr output.

- [ ] **Step 1:** Update the `find-strings` option reference block to add:

```text
      --interactive        Let you choose which repositories to search
                           (space toggles a repo, Enter confirms); empty
                           selection cancels the run
```

- [ ] **Step 2:** Add an "Interactive repo selection" subsection (after the
  `find-strings — option reference` section, before "Example invocation"):

```markdown
### Interactive repo selection

By default `find-strings` searches every reachable project (after
`excludeRepos`/`--exclude`). Pass `--interactive` to pick the repos yourself
before the search runs:

```bash
gitlab-analyzer find-strings 'TODO' --interactive
```

An `enquirer` multi-select list shows every repo initially selected. Use
**space** to toggle a repo, **arrows** to move, **Enter** to confirm. The
search then runs only against the repos you left selected. If you deselect
every repo and confirm, the run is cancelled (message on stderr, exit code 0,
no search). In non-interactive (default) mode the resolved repo list is printed
to stderr before searching so you can see where the search will run.
```
```

  Note the nested fence — use ` ``` `` ` for the inner bash block or keep the
  markdown fences balanced.

- [ ] **Step 3:** Add a `selectedRepos` bullet to the Programmatic API section's
  options example:

```ts
  excludeRepos: ['archived-repo'],
  selectedRepos: [
    { id: 42, name: 'frontend-app' },
    { id: 7, name: 'backend-api' },
  ],
```

- [ ] **Step 4:** Commit (approval first):

```bash
git add README.md
git commit -m "docs: document --interactive and selectedRepos"
```

---
---

## Self-Review

**Spec coverage:**
- Interactive mode behind `--interactive` → Task 4 (Steps 3–6).
- `excludeRepos` applies first, interactive is a second level → Task 3 filter + Task 4 Step 6 filtered list.
- No `--no-interactive` → not implemented, correct.
- Repo list printed to stderr for info → Task 4 Step 7.
- `enquirer` multiselect → Task 1 dep + Task 2 `enquirerRepoSelect`.
- Shared reusable pure util with prompt injection → Task 2.
- `findStrings` stays pure with `selectedRepos` → Task 3.
- Empty selection = cancel, exit 0 → Task 4 Step 6 + test.
- Headless stderr format (header + one per line) → Task 4 Step 7.
- Interactive doesn't print headless list → guarded by `if (!resolved.interactive)`.
- Docs (README + help) → Tasks 4 Step 5 + Task 5.
- `report()` output layer for future `--enable-logs` → Task 4 Step 3.

**Placeholder scan:** no TBD/TODO placeholders; every code step has full code.

**Type consistency:** `RepoInfo` import path `../types.ts` everywhere; `RepoSelectPrompt` return `Promise<RepoInfo[]>`; `selectedRepos` type `readonly RepoInfo[]` consistent between Task 3 and Task 4. `report(line)` signature consistent.
