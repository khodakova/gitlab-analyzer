# @gitlab-analyzer/cli

## 0.2.0

### Minor Changes

- a37ef2b: New `fetch-files` command: downloads every file matching glob
  patterns (e.g. all `package-lock.json`) from all reachable repositories in
  a single run — tree walk + raw blob fetch, parallel by repo
  (`--concurrency`, default 5), `--branch`, `--repo-filter`, `--exclude`,
  `--file-exclude`, `--interactive`, `--metrics-file`. Results land in a
  fresh timestamped `fetch-files-results-<timestamp>/` directory with
  `meta.json` and three output layouts via `--format`:
  - `json` (default) — one `results.json` with all repos and embedded
    contents; binaries saved separately, referenced via `savedAs`;
  - `ndjson` — one self-contained `<repo>.ndjson` per repo (one line per
    file, binaries carry `savedAs`; no flat `results.ndjson` index);
  - `txt` — human-readable dump with placeholders for binaries/failed files.
  New `--output-filter <found|all>` selects which repos get artifacts
  (default `found`). Unsafe paths are skipped with `status: "failed"` in
  meta; the repo may drop to `partial`.

### Patch Changes

- Updated dependencies
  - @gitlab-analyzer/core@0.1.0

## 0.1.0

### Minor Changes

- 14167ae: Add a `list-repos` CLI command: prints the repositories that `find-matches`
  would scan with the same repo-level filters (`--repo-filter`, `--exclude`,
  config `defaults.repoNameFilter` / `defaults.excludeRepos`) — without
  downloading archives or running a search. Names go to stdout (one per line,
  sorted) so the list is pipeable; progress and the count summary go to stderr.
  Empty result prints a message to stderr and exits 0. Note: `--branch` and the
  file globs do not affect this list — they act during the scan, not at
  list time.

### Patch Changes

- bfd630d: Improve CLI log output: add log levels (info/success/warn), debug `[debug]`
  prefixes, symbols (✓/⚠/ℹ/✗), colors (NO_COLOR-aware), a write mutex, blank
  lines between phases, and a final summary block; use latin `s` for durations.
  Core adds new public API: logger.info/success/warn, flushLogs(), formatDuration().
- ff41e6e: Add search performance metrics. Core exposes a new `onRepoTiming(timing)`
  option on `findMatches` (per-repo download/unzip/scan timings plus aggregated
  file counters, fired for success and failure) and optional mutable `metrics?`
  accumulators on `getProjectArchive`/`findStrInZip`/`getAllProjects` (re-exported
  from `@gitlab-analyzer/core/internal`, not the public API). The CLI prints a
  compact run-level `Metrics:` summary to stderr and, with `--metrics-file
<path>`, writes machine-readable NDJSON (`run`/`repo`/`summary` records) —
  diagnostic output that never changes the report. Heap growth is sampled once
  per run (`totalHeapGrowthBytes`, may be negative).
- Updated dependencies [57e8952]
- Updated dependencies [bfd630d]
- Updated dependencies [0116927]
- Updated dependencies [ff41e6e]
  - @gitlab-analyzer/core@0.1.0
