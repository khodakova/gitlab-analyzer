import JSZip from 'jszip';
import picomatch from 'picomatch';
import pLimit from 'p-limit';
import { getProjectArchive, getProjectRepositorySize } from '../api/project-archive.ts';
import { getAllProjects } from '../utils/get-projects.ts';
import { logger, isLoggingEnabled } from '../utils/logger.ts';
import type { SearchProjectsItem } from '../types.ts';
import type {
  CompiledFileFilters,
  FileMatch,
  FindMatchesOptions,
  MatchResult,
  NamedProject,
  RepoTiming,
  RunProgress,
  ScanMetrics,
} from './find-matches.types.ts';

/** Compile the glob patterns from `opts` into matchers, reused across all archives. */
function compileFileFilters(opts: FindMatchesOptions): CompiledFileFilters {
  // picomatch silently swallows malformed patterns — we don't add validation (per spec).
  const fileInclude = opts.fileInclude ?? [];
  const fileExclude = opts.fileExclude ?? [];
  return {
    includeMatchers: fileInclude.map((pattern) => picomatch(pattern)),
    excludeMatchers: fileExclude.map((pattern) => picomatch(pattern)),
  };
}

/**
 * Order projects by `repository_size` ascending. Small repos go first so giant
 * ones don't hold p-limit slots while small ones are still running (~25–30s
 * wall-time saving on 100+ repos, see metrics-1.ndjson). Unknown size
 * (`undefined`/`null`) is treated as 0 — such repos are not deferred to the
 * tail. `Array.prototype.sort` in V8 is stable (Timsort), so equal sizes keep
 * the GitLab API order (`order_by: 'name', sort: 'asc'`).
 */
function sortByRepositorySize(projects: SearchProjectsItem[]): void {
  projects.sort((a, b) => {
    const sizeA = a.statistics?.repository_size ?? 0;
    const sizeB = b.statistics?.repository_size ?? 0;
    return sizeA - sizeB;
  });
  if (projects.every((project) => project.statistics?.repository_size == null))
    logger.warn('no statistics.repository_size (token without Reporter+ rights?): size-based prioritization won\'t work');
}

/**
 * Fetch the project's archive, normalising both failure signals (thrown error
 * and legacy `null` return) into a single `{ archive, error }` result.
 */
async function fetchArchiveSafely(
  project: NamedProject,
  branch: string,
  downloadMetrics: { downloadMs: number },
): Promise<{ archive: Blob | ArrayBuffer | null; error?: string }> {
  try {
    const archive = await getProjectArchive(project.id, {
      projectName: project.name,
      branch,
      metrics: downloadMetrics,
    });
    if (archive === null) {
      // Compatibility: callers that return `null` (instead of throwing) to
      // signal an unreachable archive.
      return {
        archive: null,
        error: `Failed to fetch archive for project ${project.name} ${project.id}`,
      };
    }
    return { archive };
  } catch (err) {
    return { archive: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Assemble the per-repo {@link RepoTiming} from the phase accumulators. */
function buildRepoTiming(
  project: NamedProject,
  downloadMetrics: { downloadMs: number },
  scanMetrics: ScanMetrics,
  startedAt: number,
  error?: string,
): RepoTiming {
  return {
    projectId: project.id,
    projectName: project.name,
    downloadMs: downloadMetrics.downloadMs,
    unzipMs: scanMetrics.unzipMs,
    scanMs: scanMetrics.scanMs,
    totalMs: performance.now() - startedAt,
    filesScanned: scanMetrics.filesScanned,
    filesMatched: scanMetrics.filesMatched,
    textLength: scanMetrics.textLength,
    ...(error !== undefined ? { error } : {}),
  };
}

/** Emit the per-repo timing through both channels (`onRepoTiming` and `metrics.perRepo`). */
function emitTiming(opts: FindMatchesOptions, timing: RepoTiming): void {
  opts.onRepoTiming?.(timing);
  opts.metrics?.perRepo.push(timing);
}

/**
 * Search a single ZIP archive for files containing any of the given search
 * strings, applying the glob-based file filters.
 *
 * @param archive - ZIP archive as `ArrayBuffer` (or `Blob`/`null` for callers
 *   that have not yet converted). `null` yields an empty result.
 * @param searchStrings - Substrings to search for (logical OR).
 * @param filters - Pre-compiled `CompiledFileFilters` (already built once in
 *   `findMatches`; this function does NOT recompile). Matchers interpret
 *   `picomatch` defaults (case-sensitive; dotfiles NOT matched) and run
 *   against the full archive path, including its leading `/`.
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
  filters: CompiledFileFilters,
  metrics?: ScanMetrics,
): Promise<FileMatch[]> {
  if (archive === null) {
    return [];
  }

  const results: FileMatch[] = [];
  let scanMs = 0;

  try {
    const zip = new JSZip();
    logger.debug('Unpacking archive... (loading zip into memory)');
    const tUnzip = Date.now();
    await zip.loadAsync(archive);
    if (metrics) metrics.unzipMs = Date.now() - tUnzip;
    logger.debug(`Archive unpacked: ${Object.keys(zip.files).length} files, searching for substrings...`);

    const tScan = Date.now();
    for (const [filename, file] of Object.entries(zip.files)) {
      if (file.dir) {
        continue;
      }

      // Empty include = "everything"; exclude is always checked (even when include is empty).
      if (
        filters.includeMatchers.length > 0 &&
        !filters.includeMatchers.some((matcher) => matcher(filename))
      ) {
        continue;
      }
      if (filters.excludeMatchers.some((matcher) => matcher(filename))) {
        continue;
      }

      const content = await file.async('text');

      // Single-pass scan: matching strings are computed once and reused for
      // metrics and the result (instead of re-scanning the content 3 times).
      const matched = searchStrings.filter((searchString) => content.includes(searchString));

      if (metrics) {
        metrics.filesScanned++;
        metrics.textLength += content.length;
        if (matched.length > 0) {
          metrics.filesMatched++;
        }
      }

      if (matched.length > 0) {
        const lines = content.split('\n');
        results.push({ filename, matches: matched, content: lines });
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
 * Load the project list (or reuse `opts.projects`), apply the exclude/selected
 * filters, and order the survivors by repository size (small first).
 */
async function fetchCandidateProjects(opts: FindMatchesOptions): Promise<NamedProject[]> {
  const fetchedProjects =
    opts.projects ??
    (await getAllProjects(opts.repoNameFilter ?? '', opts.metrics?.list));

  const candidateProjects = fetchedProjects.filter(
    (project): project is NamedProject =>
      project.name !== null &&
      project.name.length > 0 &&
      !(opts.excludeRepos ?? []).includes(project.name) &&
      (opts.selectedRepos === undefined ||
        opts.selectedRepos.some(
          (selected) => selected.id === project.id || selected.name === project.name,
        )),
  );

  sortByRepositorySize(candidateProjects);
  return candidateProjects;
}

/**
 * Process a single project: fetch its archive, scan it, and emit all progress
 * and timing callbacks. Returns the {@link MatchResult}, or `null` when the
 * archive could not be fetched.
 */
async function processProject(
  project: NamedProject,
  opts: FindMatchesOptions,
  filters: CompiledFileFilters,
  progress: RunProgress,
): Promise<MatchResult | null> {
  const branch = opts.branch;
  opts.onRepoStart?.(project.name);
  logger.debug(`Downloading archive: ${project.name} (id=${project.id}, branch=${branch})...`);

  // Local accumulators, not `opts.metrics.perRepo`: a failed repo must not leak
  // partial data into `metrics.perRepo` — the full RepoTiming is appended once
  // at the end, for both success and failure.
  const startedAt = performance.now();
  const downloadMetrics = { downloadMs: 0 };
  const scanMetrics: ScanMetrics = { unzipMs: 0, scanMs: 0, filesScanned: 0, filesMatched: 0, textLength: 0 };

  const { archive, error } = await fetchArchiveSafely(project, branch, downloadMetrics);

  let matches: FileMatch[] = [];
  if (error === undefined && archive !== null) {
    matches = await findStrInZip(archive, opts.searchStrings, filters, scanMetrics);
  }

  const timing = buildRepoTiming(project, downloadMetrics, scanMetrics, startedAt, error);

  if (error !== undefined) {
    logger.warn(`Archive not received: ${project.name} (${error})`);
    // Release the slot immediately (done++ / onProgress / return null) so failed
    // repos don't hold up healthy ones in the queue.
    progress.done++;
    opts.onProgress?.(progress.done, progress.total, project.name, error);
    // Size diagnostics — only when logging is enabled and WITHOUT blocking the
    // p-limit slot: fire-and-forget AFTER the slot is released. A failed repo is
    // often "fat" (bloated history); the warning hints at the cause.
    if (isLoggingEnabled()) {
      void getProjectRepositorySize(project.id).then((size) => {
        if (size !== undefined) {
          logger.warn(
            `WARNING: repository ${project.name} failed to download — git history size ` +
              `${(size / 1024 / 1024).toFixed(1)} MB. Check it or exclude it (--exclude).`,
          );
        }
      });
    }
    emitTiming(opts, timing);
    return null;
  }

  logger.success(`Done: ${project.name} (${matches.length} file(s) with matches)`);
  progress.done++;
  opts.onProgress?.(progress.done, progress.total, project.name);
  emitTiming(opts, timing);

  return {
    projectId: project.id,
    projectName: project.name,
    projectDescription: project.description,
    resultsLength: matches.length,
    results: matches,
  };
}

/** Run the per-project search tasks under the limiter and drop the failures. */
async function runSearch(
  candidateProjects: NamedProject[],
  opts: FindMatchesOptions,
  filters: CompiledFileFilters,
  limit: ReturnType<typeof pLimit>,
): Promise<MatchResult[]> {
  const progress: RunProgress = { done: 0, total: candidateProjects.length };

  const tasks = candidateProjects.map((project) =>
    limit(() => processProject(project, opts, filters, progress)),
  );

  const results = await Promise.all(tasks);
  return results.filter((result): result is MatchResult => result !== null);
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
 * const results = await findMatches({
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
export async function findMatches(opts: FindMatchesOptions): Promise<MatchResult[]> {
  const filters = compileFileFilters(opts);
  const candidateProjects = await fetchCandidateProjects(opts);
  const limit = pLimit(opts.concurrency ?? 5);
  return runSearch(candidateProjects, opts, filters, limit);
}
