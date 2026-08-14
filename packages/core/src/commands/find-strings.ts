import JSZip from 'jszip';
import pLimit from 'p-limit';
import { getProjectArchive, getProjectRepositorySize } from '../api/project-archive.ts';
import { getAllProjects } from '../utils/get-projects.ts';
import { logger, isLoggingEnabled } from '../utils/logger.ts';
import type { SearchProjectsItem, RepoInfo } from '../types.ts';

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Input options for {@link findStrings}.
 *
 * Only `searchStrings` and `branch` are required; everything else falls back
 * to a sensible default documented per field.
 */
export type FindStringsOptions = {
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
   * Substring filter for file paths inside the archive. Default `'/src/'`.
   * Real GitLab archives use absolute paths (e.g. `/src/foo.ts`), so the
   * default matches files under any directory named `src`. Set to `'/'`
   * to scan every file.
   */
  pathFilter?: string;

  /**
   * Whether to include `*.test.*` files in the search. Default `false`.
   * When `false`, any file whose path contains `.test.ts` is skipped before
   * the content check.
   */
  includeTests?: boolean;

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
   * Optional pre-loaded project list. When provided, `findStrings` does NOT
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
   * returned array or the report shape. `findStrings` remains pure (it only
   * calls the callback, it never writes output itself).
   * @param timing - Per-repo performance metrics for the repository that just
   *   finished processing.
   */
  onRepoTiming?: (timing: RepoTiming) => void;

  /**
   * Optional shared mutable accumulator for run-scope search metrics. When
   * provided, `findStrings` writes list metrics (into `metrics.list`) and
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

type FileMatch = MatchResult['results'][number];

/**
 * Per-repository performance metrics, emitted via {@link FindStringsOptions.onRepoTiming}.
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
 * `findStrings` fills in place as it runs — `list` from the project-list fetch,
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

/**
 * Search a single ZIP archive for files containing any of the given search
 * strings, applying the path and test-file filters.
 *
 * @param archive - ZIP archive as `ArrayBuffer` (or `Blob`/`null` for callers
 *   that have not yet converted). `null` yields an empty result.
 * @param searchStrings - Substrings to search for (logical OR).
 * @param filters - `pathFilter` substring and `includeTests` flag.
 * @param metrics - Optional mutable accumulator. Filled with the unzip
 *   duration, the scan-loop duration, and aggregated per-file counters
 *   (filesScanned/filesMatched/textLength). Caller is expected to
 *   pre-initialise the fields to 0; this function only writes when it actually
 *   measures (e.g. `archive === null` → untouched, stays at the caller's zeroes).
 * @returns Array of `{filename, matches, content}` for every matching file.
 *   On ZIP parse error returns `[]` silently.
 */
export async function findStrInZip(
  archive: Blob | ArrayBuffer | null,
  searchStrings: string[],
  filters: { pathFilter: string; includeTests: boolean },
  metrics?: {
    unzipMs: number;
    scanMs: number;
    filesScanned: number;
    filesMatched: number;
    textLength: number;
  },
): Promise<FileMatch[]> {
  if (archive === null) {
    return [];
  }

  const results: FileMatch[] = [];
  let scanMs = 0;

  try {
    const zip = new JSZip();
    logger.debug('Распаковка архива… (загрузка zip в память)');
    const tUnzip = Date.now();
    await zip.loadAsync(archive);
    if (metrics) metrics.unzipMs = Date.now() - tUnzip;
    logger.debug(`Архив распакован: ${Object.keys(zip.files).length} файлов, ищу подстроки…`);

    const tScan = Date.now();
    for (const [filename, file] of Object.entries(zip.files)) {
      if (file.dir) {
        continue;
      }
      if (!filename.includes(filters.pathFilter)) {
        continue;
      }
      if (!filters.includeTests && filename.includes('.test.ts')) {
        continue;
      }

      const content = await file.async('text');

      // Aggregate per-file counters only AFTER the content is decoded (need
      // `content.length`). textLength is UTF-16 code units, not byte count.
      if (metrics) {
        metrics.filesScanned++;
        metrics.textLength += content.length;
        if (searchStrings.some((s) => content.includes(s))) {
          metrics.filesMatched++;
        }
      }

      if (searchStrings.some((s) => content.includes(s))) {
        const matches = searchStrings.filter((s) => content.includes(s));
        const lines = content.split('\n');
        results.push({ filename, matches, content: lines });
      }
    }
    scanMs = Date.now() - tScan;
  } catch {
    return [];
  } finally {
    if (metrics) metrics.scanMs = scanMs;
  }

  return results;
}

/**
 * Search a GitLab instance for files containing any of the given search strings.
 *
 * Discovers projects via the GitLab API (unless `opts.projects` is provided,
 * in which case that pre-loaded list is used and no project fetch happens),
 * fetches each project's archive (capped at `opts.concurrency` parallel
 * fetches via `p-limit`), unzips it in-memory, and returns one
 * {@link MatchResult} per project describing which files matched which search
 * strings.
 *
 * The function is intentionally pure: no `console.*` output, no file
 * writes, no `process.exit`. All progress reporting goes through
 * `opts.onProgress` (if provided). File persistence and exit codes are
 * the CLI's responsibility.
 *
 * @param opts - Search parameters. `searchStrings` and `branch` are required;
 *   everything else falls back to a sensible default.
 * @returns Array of {@link MatchResult}, one per project processed
 *   (projects whose archive fetch failed are omitted). Order is not
 *   guaranteed — sorting is the caller's job.
 * @throws Re-throws errors from `getAllProjects` (network/auth issues with
 *   the projects-list endpoint) — only when `opts.projects` is not provided.
 *   Archive-parse failures are swallowed per-project and surfaced as
 *   `resultsLength: 0`.
 *
 * @example
 * ```ts
 * const results = await findStrings({
 *   searchStrings: ['my-secret', 'TODO'],
 *   branch: 'develop',
 *   concurrency: 5,
 *   onProgress: (done, total, repo) => console.log(`[${done}/${total}] ${repo}`),
 * });
 *
 * const totalMatches = results.reduce(
 *   (acc, r) => acc + r.results.reduce((a, x) => a + x.matches.length, 0),
 *   0,
 * );
 * console.log(`Found ${totalMatches} matches across ${results.length} repos`);
 * ```
 */
export async function findStrings(opts: FindStringsOptions): Promise<MatchResult[]> {
  const searchStrings = opts.searchStrings;
  const branch = opts.branch;
  const pathFilter = opts.pathFilter ?? '/src/';
  const includeTests = opts.includeTests ?? false;
  const excludeRepos = opts.excludeRepos ?? [];
  const selectedRepos = opts.selectedRepos;

  const allProjects =
    opts.projects ??
    (await getAllProjects(opts.repoNameFilter ?? '', opts.metrics?.list));
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

  const total = projects.length;
  let done = 0;
  const limit = pLimit(opts.concurrency ?? 5);

  const tasks = projects.map((project) => limit(async (): Promise<MatchResult | null> => {
    opts.onRepoStart?.(project.name);
    logger.debug(`Скачивание архива: ${project.name} (id=${project.id}, branch=${branch})…`);

    // Per-repo timing: local accumulators (not `opts.metrics.perRepo`), so a
    // failed repo doesn't leak partial data into `metrics.perRepo` — the full
    // RepoTiming is appended once at the end for BOTH success and failure.
    const t0 = performance.now();
    const archMetrics = { downloadMs: 0 };
    const zipMetrics = { unzipMs: 0, scanMs: 0, filesScanned: 0, filesMatched: 0, textLength: 0 };
    let archive: Blob | ArrayBuffer | null = null;
    let errorMsg: string | undefined;
    try {
      archive = await getProjectArchive(project.id, {
        projectName: project.name,
        branch,
        metrics: archMetrics,
      });
      if (archive === null) {
        // Compatibility path: callers that still return `null` (instead of
        // throwing) to signal an unreachable archive.
        errorMsg = `Не удалось получить архив по проекту ${project.name} ${project.id}`;
      }
    } catch (err) {
      archive = null;
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    let fileMatches: FileMatch[] = [];
    if (errorMsg === undefined && archive !== null) {
      fileMatches = await findStrInZip(archive, searchStrings, { pathFilter, includeTests }, zipMetrics);
    }

    // Build the per-repo timing regardless of success/failure.
    const timing: RepoTiming = {
      projectId: project.id,
      projectName: project.name,
      downloadMs: archMetrics.downloadMs,
      unzipMs: zipMetrics.unzipMs,
      scanMs: zipMetrics.scanMs,
      totalMs: performance.now() - t0,
      filesScanned: zipMetrics.filesScanned,
      filesMatched: zipMetrics.filesMatched,
      textLength: zipMetrics.textLength,
      ...(errorMsg !== undefined ? { error: errorMsg } : {}),
    };

    if (errorMsg !== undefined) {
      logger.warn(`Архив не получен: ${project.name} (${errorMsg})`);
      // Сразу освобождаем слот (done++ / onProgress / return null) — чтобы
      // упавшие репо не задерживали здоровые в очереди.
      done++;
      opts.onProgress?.(done, total, project.name, errorMsg);
      // Диагностика размера — только при включённых логах, и НЕ блокируя слот
      // p-limit: запускаем fire-and-forget ПОСЛЕ освобождения. Упавшее репо
      // часто «жирное» (раздутая история); предупреждение подскажет причину.
      if (isLoggingEnabled()) {
        void getProjectRepositorySize(project.id).then((size) => {
          if (size !== undefined) {
            logger.warn(`ВНИМАНИЕ: репозиторий ${project.name} не скачался — объём git-истории ${mb(size)}. Скорее всего репо раздуто; проверь или исключи его (--exclude).`);
          }
        });
      }
      // Emit per-repo timing for the failed repo too (downloadMs ≈ timeout).
      opts.onRepoTiming?.(timing);
      opts.metrics?.perRepo.push(timing);
      return null;
    }

    logger.success(`Готово: ${project.name} (${fileMatches.length} файл(ов) с совпадениями)`);
    done++;
    opts.onProgress?.(done, total, project.name);

    opts.onRepoTiming?.(timing);
    opts.metrics?.perRepo.push(timing);

    return {
      projectId: project.id,
      projectName: project.name,
      projectDescription: project.description,
      resultsLength: fileMatches.length,
      results: fileMatches,
    };
  }));

  const settled = await Promise.all(tasks);
  return settled.filter((r): r is MatchResult => r !== null);
}
