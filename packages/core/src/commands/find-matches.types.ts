import type { RepoInfo, SearchProjectsItem } from '../types.ts';

/**
 * Glob-based file filters applied during the in-archive scan
 * (see {@link findStrInZip}). Replaces the legacy substring
 * path-filter + boolean include-tests pair (both removed). Both
 * arrays default to "no filter" (empty `[]`), so omitting both
 * options scans EVERY file in every archive.
 *
 * - `fileInclude`: glob patterns matched against the archive entry's
 *   full path (e.g. `/src/foo.ts`). Empty array = no include filter.
 *   When non-empty, at least one pattern must match for the file to
 *   be scanned (logical OR between patterns).
 * - `fileExclude`: glob patterns that force-skip a file
 *   (gitignore-style: ALWAYS wins over `fileInclude`). Empty array =
 *   no exclude filter.
 *
 * Patterns are interpreted by `picomatch`. Leading slashes in
 * archive paths are preserved as-is.
 */
export type FileFilters = {
  fileInclude: readonly string[];
  fileExclude: readonly string[];
};

/**
 * Input options for {@link findMatches}.
 *
 * Only `searchStrings` and `branch` are required; everything else falls back
 * to a sensible default documented per field.
 */
export type FindMatchesOptions = {
  /**
   * Strings to search for. A file is considered a match if its content
   * includes ANY of these substrings (logical OR). The `matches` array on
   * each `MatchResult.results[i]` is the subset that actually hit.
   */
  searchStrings: string[];

  /**
   * Git branch to scan in every project. Required — no default. CLI callers
   * typically pull this from config (`defaults.branch`, default `'develop'`).
   */
  branch: string;

  /**
   * Optional substring filter for project names. Passed straight to the
   * GitLab projects API as `search=`. Empty string (default) returns all
   * projects.
   * @example `'frontend'`
   */
  repoNameFilter?: string;

  /**
   * Optional list of project names to skip after fetching the project list.
   * Useful for excluding archived / WIP / unrelated repos. Names are matched
   * case-sensitively against `project.name`.
   */
  excludeRepos?: readonly string[];

  /**
   * Optional explicit allowlist of repositories to search. When provided,
   * only projects whose `id` OR `name` matches an entry are scanned. Applied
   * AFTER `excludeRepos` (intersection). Omit (or `undefined`) to keep the
   * legacy behaviour: search every project not excluded by `excludeRepos`.
   */
  selectedRepos?: readonly RepoInfo[];

  /**
   * Glob patterns for file paths to SCAN inside each archive
   * (logical OR between patterns). Empty / `undefined` = no include
   * filter — every file is a candidate (legacy substring path-filter
   * with default `/src/` is gone; the new default is "scan all").
   *
   * Patterns are interpreted by `picomatch` with default options
   * (case-sensitive; dotfiles NOT matched). Paths from the archive
   * keep their leading slash, so a single-segment glob does NOT
   * match a nested path — use a double-star segment to traverse any
   * nesting level.
   */
  fileInclude?: readonly string[];

  /**
   * Glob patterns for file paths to SKIP (logical OR between patterns).
   * Gitignore-style — ALWAYS wins over `fileInclude`. Empty /
   * `undefined` = no exclude filter. Replaces the boolean
   * include-tests flag (the only "negative" filter previously;
   * `true` meant "skip test files"). Same `picomatch` defaults
   * as `fileInclude`.
   */
  fileExclude?: readonly string[];

  /**
   * Maximum number of archive-fetch + zip-parse tasks running in parallel.
   * Default `5`. Lower this if you hit GitLab rate limits. Each project
   * occupies one slot for the duration of BOTH its archive fetch and its
   * zip parse — they are NOT split across two separate limits.
   */
  concurrency?: number;

  /**
   * Optional progress callback. Fires once per project (success OR failure),
   * with `done` being the 1-based count of projects processed so far.
   * @param done - Projects processed so far (1-based).
   * @param total - Total projects to process (after `excludeRepos` filter).
   * @param currentRepo - Name of the project that just finished.
   * @param error - Present when the project's archive could not be fetched
   *   (null/`undefined` on success). Carries the underlying error message so
   *   callers can record why a repo failed (e.g. missing branch, private,
   *   archived, removed mid-scan).
   */
  onProgress?: (
    done: number,
    total: number,
    currentRepo: string,
    error?: string,
  ) => void;

  /**
   * Optional callback fired when a repository STARTS processing, before its
   * archive is fetched. Useful for callers that render live progress while
   * repos run concurrently — `onProgress` only fires when a repo FINISHES, so
   * it cannot, on its own, tell you which repos are currently active. This
   * hook fills that gap.
   * @param repo - Name of the project that just started processing.
   */
  onRepoStart?: (repo: string) => void;

  /**
   * Optional pre-loaded project list. When provided, `findMatches` does NOT
   * fetch the project list from GitLab again (skips `getAllProjects`);
   * `repoNameFilter` is then ignored for the fetch (it is assumed to already
   * be applied to `projects`). Filtering by `excludeRepos` and `selectedRepos`
   * is still applied on top. Lets a caller that already fetched the list
   * (e.g. a CLI that built the repo picker) avoid a duplicate network call.
   */
  projects?: readonly SearchProjectsItem[];

  /**
   * Optional callback fired once per processed repository (both success AND
   * failure), immediately after `onProgress`. Carries per-repo performance
   * metrics (download/unzip/scan durations, aggregated file stats, and the
   * `error` message for a repo whose archive could not be fetched). This is a
   * separate channel from the `MatchResult` result — it does NOT alter the
   * returned array or the report shape. `findMatches` remains pure (it only
   * calls the callback, it never writes output itself).
   * @param timing - Per-repo performance metrics for the repository that just
   *   finished processing.
   */
  onRepoTiming?: (timing: RepoTiming) => void;

  /**
   * Optional shared mutable accumulator for run-scope search metrics. When
   * provided, `findMatches` writes list metrics (into `metrics.list`) and
   * appends one entry to `metrics.perRepo` for each processed repository (via
   * {@link onRepoTiming}). Intended for CLIs/mcp servers that want the whole
   * run's metrics in one place; ordinary library callers can ignore it and use
   * {@link onRepoTiming} directly. Not part of the public API contract — the
   * CLI consumes it from `@gitlab-analyzer/core/internal`.
   */
  metrics?: SearchMetrics;
};

/**
 * Result of searching a single project for the given strings.
 *
 * One `MatchResult` is emitted per project that was processed (i.e. whose
 * archive was fetched successfully). Projects whose archive fetch failed
 * are silently omitted from the returned array.
 */
export type MatchResult = {
  /** GitLab project ID. Matches `SearchProjectsItem.id` from `src/types.ts`. */
  projectId: number;

  /**
   * Project name as returned by GitLab (`SearchProjectsItem.name`).
   * Always non-null — projects with null/empty names are filtered out
   * before processing.
   */
  projectName: string;

  /**
   * Project description as returned by GitLab. May be `null` if the project
   * has no description set in GitLab.
   */
  projectDescription: string | null;

  /**
   * Number of matching files (`results.length`). Convenience for callers
   * that only need the count.
   */
  resultsLength: number;

  /**
   * Per-file matches. Only files where at least one `searchStrings[i]` was
   * found are included. Order is zip-iteration order (not sorted).
   */
  results: Array<{
    /** File path inside the archive (e.g. `'/src/components/Foo.ts'`). */
    filename: string;

    /** Subset of `searchStrings` that were found in this file. */
    matches: string[];

    /**
     * Full file content split by `\n`. A trailing newline in the file
     * produces an empty final entry.
     */
    content: string[];
  }>;
};

/** A single matching file entry inside a {@link MatchResult}. */
export type FileMatch = MatchResult['results'][number];

/**
 * Compiled glob matchers, one per pattern in `FileFilters`. Built once
 * in `findMatches` (fail-fast on invalid patterns) and reused across
 * every archive. Internal — not exported from the package.
 */
export type CompiledFileFilters = {
  includeMatchers: Array<(path: string) => boolean>;
  excludeMatchers: Array<(path: string) => boolean>;
};

/**
 * Per-repository performance metrics, emitted via {@link FindMatchesOptions.onRepoTiming}.
 *
 * Breakdown is per phase: `downloadMs` (archive fetch), `unzipMs` (in-memory
 * unzip), `scanMs` (the file-content search loop). `totalMs` is the whole repo
 * (measured from `onRepoStart` to readiness) and is NOT necessarily the sum of
 * the three phases — there is per-result parsing and external overhead on top.
 *
 * Memory is deliberately NOT part of this type: heap is sampled once per RUN
 * (`totalHeapGrowthBytes`), not per repo.
 */
export type RepoTiming = {
  projectId: number;
  projectName: string;
  downloadMs: number;
  unzipMs: number;
  scanMs: number;
  totalMs: number;
  /** Number of files that passed the filters and were content-scanned. */
  filesScanned: number;
  /** Number of scanned files that contained at least one search string. */
  filesMatched: number;
  /** UTF-16 code units from `content.length`, not byte count. */
  textLength: number;
  /** Set for a repo whose archive could not be fetched. */
  error?: string;
};

/**
 * Run-scope accumulator for search metrics. A single flat mutable record that
 * `findMatches` fills in place as it runs — `list` from the project-list fetch,
 * `perRepo` appended per processed repo, `summary` for run-scope heap growth.
 *
 * This is an internal (NOT public `index.ts`) type: the CLI consumes it via
 * `@gitlab-analyzer/core/internal`.
 */
export type SearchMetrics = {
  list: { listMs: number; pagesFetched: number; reposFound: number };
  /** Grows as repositories finish (same entries as `onRepoTiming`). */
  perRepo: RepoTiming[];
  /** Run-scope summary. `totalHeapGrowthBytes` may be negative (GC). */
  summary: { totalHeapGrowthBytes?: number };
};

/** Per-project counters collected while unzipping and scanning an archive. */
export type ScanMetrics = {
  unzipMs: number;
  scanMs: number;
  filesScanned: number;
  filesMatched: number;
  textLength: number;
};

/** Mutable progress shared across concurrent per-project tasks. */
export type RunProgress = { done: number; total: number };

/** A project whose name is known non-null (survives the candidate filter). */
export type NamedProject = SearchProjectsItem & { name: string };
