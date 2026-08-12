# Interactive Repository Selection for `find-strings` — Design Spec

**Date:** 2026-08-12
**Status:** Approved (design confirmed via Q&A session)
**Author:** Sisyphus (via brainstorm/clarification session)

## Goal

Let a user interactively pick *which* repositories `find-strings` searches,
instead of always searching every reachable project. Also print the resolved
repo list to stderr before the search starts (headless mode) so the user knows
where the search will run.

## Out of scope

- Implementing the future `--enable-logs` flag and per-repo log output. This
  change only introduces the thin output layer (`report(...)`) it will build on.
- Any git operations, releases, or changeset entries — decided during execution.
- Changing the `excludeRepos` mechanism or the `--exclude` flag semantics.

## Locked decisions (from Q&A)

| # | Decision | Rationale |
|---|---|---|
| 1 | Interactive selection runs **only with `--interactive`**; default is headless (search immediately) | Keeps current pipeable/automation behaviour intact |
| 2 | `excludeRepos` / `--exclude` continue to apply first; interactive selection is a *second* level on the already-filtered list | Two independent levels of exclusion |
| 3 | No `--no-interactive` flag — `--interactive` is the only toggling flag | One flag, less surface |
| 4 | Resolved repo list is printed to **stderr** for information | Keeps stdout JSON pipeable |
| 5 | Library: **`enquirer`** `multiselect` (same as changesets) | Proven, matches requested space/enter UX |
| 6 | Shared reusable **repo-select utility** in CLI layer (next to `user-confirm.ts`) | Reusable by future commands |
| 7 | Utility is a **pure function** with **prompt injection** (default = enquirer impl) | Testable via mock; no hidden TTY dependency |
| 8 | `findStrings` stays pure; receives a **`selectedRepos: {id, name}[]`** option | Library API stays clean |
| 9 | Empty selection in interactive mode = **cancel**: message to stderr, `process.exit(0)`, no search | Not an error; user chose nothing |
| 10 | Headless stderr list format: one header line + one repo name per line | Readable and trivially greppable |
| 11 | Interactive mode does **not** print the headless stderr list (it's visible in the picker) | No duplicate output |
| 12 | Docs (README + commander help) updated in-scope | Feature isn't complete without docs |
| 13 | Output layer is a thin `report()` so `--enable-logs` (later) can add levels | Future extension point, cheap now |

## Behaviour

### Headless (no `--interactive`)

1. Resolve options, fetch project list, apply `excludeRepos`/`--exclude`
   (existing behaviour, unchanged).
2. Print to stderr:

   ```
   Будет выполнен поиск по N репозиториям:
   repo-a
   repo-b
   ...
   ```

3. Search proceeds as today.

### Interactive (`--interactive`)

1. Resolve options, fetch project list, apply `excludeRepos` (same step).
2. Show an `enquirer` `multiselect` with every repo initially **selected**;
   user toggles any repo with **space**, navigates with **arrows**,
   confirms with **Enter**.
3. If nothing is selected at confirm → print message to stderr and
   `process.exit(0)` (no search).
4. Otherwise pass the selected `{id, name}[]` as `selectedRepos` to
   `findStrings`, which searches only those.

## File map

| Action | Path | Responsibility |
|---|---|---|
| Create | `src/utils/repo-select.ts` | Shared pure repo-select prompt (prompt injected) |
| Modify | `src/commands/find-strings.ts` | Add `selectedRepos` option + second-stage filter |
| Modify | `src/cli.ts` | `--interactive` flag, `report()` layer, wire selection, empty-cancel |
| Modify | `src/index.ts` | Re-export new public type (repo pair) if needed |
| Modify | `package.json` | Add `enquirer` dependency |
| Modify | `README.md` | Document `--interactive`, `selectedRepos`, output example |
| Test | `src/utils/__tests__/repo-select.test.ts` | New |
| Test | `src/commands/__tests__/find-strings.test.ts` | `selectedRepos` filtering tests |
| Test | `src/cli/__tests__/cli.test.ts` | `--interactive` wiring, report output, empty-cancel |

## Types

### `RepoInfo` (new, shared shape)

```ts
export type RepoInfo = {
  id: number;
  name: string;
};
```

Lives in `src/types.ts`. `SortRepo`? Not needed — `RepoInfo` is the contract
between the CLI's repo list and `selectedRepos`.

### `repoSelect` (new util)

```ts
export type RepoSelectPrompt = (repos: readonly RepoInfo[]) => Promise<RepoInfo[]>;

export async function repoSelect(
  repos: readonly RepoInfo[],
  prompt: RepoSelectPrompt = enquirerRepoSelect,
): Promise<RepoInfo[]>
```

### `FindStringsOptions.selectedRepos` (new)

```ts
selectedRepos?: readonly RepoInfo[];
```

`undefined` → legacy behaviour (all projects after `excludeRepos`).

## Filtering semantics (`findStrings`)

Two independent filters applied in sequence:

1. Drop any project whose `name` is in `excludeRepos` (existing).
2. If `selectedRepos` is provided, keep only projects whose `id` **or** `name`
   matches an entry in `selectedRepos` (intersection).

```ts
const projects = allProjects.filter((p) =>
  p.name !== null &&
  p.name.length > 0 &&
  !excludeRepos.includes(p.name) &&
  (selectedRepos === undefined ||
    selectedRepos.some((s) => s.id === p.id || s.name === p.name)),
);
```

## Output layer (`report`)

Thin function in `cli.ts` (CLI layer only) so a future `--enable-logs` can add
verbosity levels. For now it writes plain lines to stderr.

```ts
function report(line: string): void {
  process.stderr.write(`${line}\n`);
}
```

Used for: the "Будет выполнен поиск по N репозиториям:" header + repo list,
progress lines, the write-summary line, and the empty-selection cancel message.
`onProgress` stays as-is (tied to `findStrings`), but the CLI's progress
handler is wired through `report`.
