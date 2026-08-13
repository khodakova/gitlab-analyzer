import JSZip from 'jszip';
import pLimit from 'p-limit';
import { getProjectArchive } from '../api/project-archive.ts';
import { getAllProjects } from '../utils/get-projects.ts';
import type { SearchProjectsItem, RepoInfo } from '../types.ts';

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
   * Optional pre-loaded project list. When provided, `findStrings` does NOT
   * fetch the project list from GitLab again (skips `getAllProjects`);
   * `repoNameFilter` is then ignored for the fetch (it is assumed to already
   * be applied to `projects`). Filtering by `excludeRepos` and `selectedRepos`
   * is still applied on top. Lets a caller that already fetched the list
   * (e.g. a CLI that built the repo picker) avoid a duplicate network call.
   */
  projects?: readonly SearchProjectsItem[];
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
 * Search a single ZIP archive for files containing any of the given search
 * strings, applying the path and test-file filters.
 *
 * @param archive - ZIP archive as `ArrayBuffer` (or `Blob`/`null` for callers
 *   that have not yet converted). `null` yields an empty result.
 * @param searchStrings - Substrings to search for (logical OR).
 * @param filters - `pathFilter` substring and `includeTests` flag.
 * @returns Array of `{filename, matches, content}` for every matching file.
 *   On ZIP parse error returns `[]` silently.
 */
async function findStrInZip(
  archive: Blob | ArrayBuffer | null,
  searchStrings: string[],
  filters: { pathFilter: string; includeTests: boolean },
): Promise<FileMatch[]> {
  if (archive === null) {
    return [];
  }

  const results: FileMatch[] = [];

  try {
    const zip = new JSZip();
    await zip.loadAsync(archive);

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

      if (searchStrings.some((s) => content.includes(s))) {
        const matches = searchStrings.filter((s) => content.includes(s));
        const lines = content.split('\n');
        results.push({ filename, matches, content: lines });
      }
    }
  } catch {
    return [];
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
    (await getAllProjects(opts.repoNameFilter ?? ''));
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
    let archive: Blob | ArrayBuffer | null;
    let errorMsg: string | undefined;
    try {
      archive = await getProjectArchive(project.id, {
        projectName: project.name,
        branch,
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

    if (errorMsg !== undefined) {
      done++;
      opts.onProgress?.(done, total, project.name, errorMsg);
      return null;
    }

    const fileMatches = await findStrInZip(archive, searchStrings, {
      pathFilter,
      includeTests,
    });

    done++;
    opts.onProgress?.(done, total, project.name);

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
