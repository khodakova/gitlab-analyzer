import pLimit from 'p-limit';
import { getCommits } from '../api/commits.ts';
import { listRepoTreeRecursive } from '../api/repository-tree.ts';
import { getAllProjects } from '../utils/get-projects.ts';
import { logger } from '../utils/logger.ts';
import { compileMatcher } from './find-matches.ts';
import type { Commit } from '../types.ts';
import type {
  LastCommitEntry,
  LastCommitFailedPath,
  LastCommitOptions,
  LastCommitResult,
} from './get-last-commits.types.ts';
import type { NamedProject, RepoTiming } from './find-matches.types.ts';

/**
 * Load the project list (or reuse `opts.projects`) and apply the same
 * candidate filter as `fetchFiles` — identical to `fetch-files`, but WITHOUT
 * the size-based sorting (commit requests are cheap; no giant-repo tail).
 */
async function fetchCandidateProjects(opts: LastCommitOptions) {
  const fetchedProjects =
    opts.projects ?? (await getAllProjects(opts.repoNameFilter ?? '', opts.metrics?.list));

  return fetchedProjects.filter(
    (project): project is NamedProject =>
      project.name !== null &&
      project.name.length > 0 &&
      !(opts.excludeRepos ?? []).includes(project.name) &&
      (opts.selectedRepos === undefined ||
        opts.selectedRepos.some(
          (selected) => selected.id === project.id || selected.name === project.name,
        )),
  );
}

/** Map a raw commit into the report entry shape. */
function toEntry(commit: Commit, path: string | null): LastCommitEntry {
  return {
    path,
    commitId: commit.id,
    shortId: commit.short_id,
    title: commit.title,
    authorName: commit.committer_name,
    committedDate: commit.committed_date,
    webUrl: commit.web_url,
  };
}

/** Append one per-repo timing entry to the shared accumulator (RepoTiming-compatible, phases zeroed). */
function pushRepoMetrics(
  metrics: LastCommitOptions['metrics'],
  entry: {
    projectId: number;
    projectName: string;
    totalMs: number;
    filesScanned: number;
    filesMatched: number;
    error?: string;
  },
): void {
  if (!metrics) return;
  const timing: RepoTiming = {
    projectId: entry.projectId,
    projectName: entry.projectName,
    downloadMs: 0,
    unzipMs: 0,
    scanMs: 0,
    totalMs: entry.totalMs,
    filesScanned: entry.filesScanned,
    filesMatched: entry.filesMatched,
    textLength: 0,
    ...(entry.error !== undefined ? { error: entry.error } : {}),
  };
  metrics.perRepo.push(timing);
}

/**
 * Per-file mode worker for a single matched path. Never throws — a failed
 * request becomes a `{path, error}` record while the rest of the paths keep
 * processing (partial-success contract).
 */
async function commitForPath(
  project: NamedProject,
  path: string,
  branch: string,
): Promise<{ commit: Commit } | { error: string }> {
  try {
    const commits = await getCommits(project.id, { path, ref_name: branch, per_page: 1 });
    return { commit: commits[0] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Commits request failed: ${project.name}/${path} (${message})`);
    return { error: message };
  }
}

/**
 * Process one repo inside a p-limit slot. Resolves the branch per repo
 * (`opts.branch ?? default_branch ?? 'develop'`), runs HEAD or per-file mode,
 * emits progress/timing. Never throws — repo-level failures come back as
 * `error` on the result.
 */
async function processRepo(
  project: NamedProject,
  opts: LastCommitOptions,
  progress: { done: number; total: number },
): Promise<LastCommitResult> {
  const branch = opts.branch ?? project.default_branch ?? 'develop';
  opts.onRepoStart?.(project.name);
  const startedAt = Date.now();

  const done = (error?: string): void => {
    progress.done++;
    opts.onProgress?.(progress.done, progress.total, project.name, error);
  };

  const failRepo = (message: string): LastCommitResult => {
    logger.warn(`Repo failed: ${project.name} (${message})`);
    done(message);
    pushRepoMetrics(opts.metrics, {
      projectId: project.id,
      projectName: project.name,
      totalMs: Date.now() - startedAt,
      filesScanned: 0,
      filesMatched: 0,
      error: message,
    });
    return {
      projectId: project.id,
      projectName: project.name,
      webUrl: project.web_url ?? null,
      branch,
      error: message,
      failed: [],
      truncated: false,
      results: [],
    };
  };

  // HEAD mode: one request for the branch tip.
  if (opts.file === undefined) {
    try {
      const commits = await getCommits(project.id, { ref_name: branch, per_page: 1 });
      const entry = commits[0] !== undefined ? [toEntry(commits[0], null)] : [];
      done();
      pushRepoMetrics(opts.metrics, {
        projectId: project.id,
        projectName: project.name,
        totalMs: Date.now() - startedAt,
        filesScanned: entry.length,
        filesMatched: entry.length,
      });
      return {
        projectId: project.id,
        projectName: project.name,
        webUrl: project.web_url ?? null,
        branch,
        error: null,
        failed: [],
        truncated: false,
        results: entry,
      };
    } catch (err) {
      return failRepo(err instanceof Error ? err.message : String(err));
    }
  }

  // Per-file mode: expand the glob via the tree, then one commits request per matched path.
  let tree;
  try {
    tree = await listRepoTreeRecursive(project.id, branch, { projectName: project.name });
  } catch (err) {
    return failRepo(err instanceof Error ? err.message : String(err));
  }

  const matcher = compileMatcher(opts.file);
  const matched = tree.entries
    .filter((entry) => entry.type === 'blob' && matcher(`/${entry.path}`))
    .map((entry) => entry.path);

  const results: LastCommitEntry[] = [];
  const failed: LastCommitFailedPath[] = [];
  // Awaited inside the repo's p-limit slot (same model as fetch-files) — the
  // per-file fan-out belongs to one slot, not to the global limiter.
  for (const path of matched) {
    const outcome = await commitForPath(project, path, branch);
    if ('error' in outcome) {
      failed.push({ path, error: outcome.error });
    } else if (outcome.commit !== undefined) {
      // A path with no reachable commit (edge cases like renames) yields no
      // entry — only a FAILED request lands in `failed` (design D8/risks).
      results.push(toEntry(outcome.commit, path));
    }
  }

  done();
  pushRepoMetrics(opts.metrics, {
    projectId: project.id,
    projectName: project.name,
    totalMs: Date.now() - startedAt,
    filesScanned: matched.length,
    filesMatched: results.length,
    error: failed.length > 0 ? `${failed.length} path(s) failed` : undefined,
  });
  return {
    projectId: project.id,
    projectName: project.name,
    webUrl: project.web_url ?? null,
    branch,
    error: null,
    failed,
    truncated: tree.truncated,
    results,
  };
}

/**
 * Report the last commit for every selected GitLab repository — either the
 * tip commit of a branch (HEAD mode) or the last commit touching each file
 * matched by `opts.file` (per-file mode).
 *
 * Mirrors `fetchFiles` plumbing: project discovery + exclude/selectedRepos
 * filters, `p-limit` concurrency (default 5 — a slot holds one repo with all
 * its per-file requests), progress via `onProgress`/`onRepoStart`, per-repo
 * timing via `onRepoTiming`/`metrics`.
 *
 * Branch resolution (design D5): `opts.branch` → project `default_branch` →
 * `'develop'`, resolved PER REPO. No config reaches core.
 *
 * The function is intentionally pure: no file writes, no `process.exit`.
 * Every processed repo — including failed ones — is present in the returned
 * array (repo-level failure → `error` text, empty `results`). `branchExists`
 * is NOT computed here; the CLI derives it from `error`.
 */
export async function getLastCommits(opts: LastCommitOptions): Promise<LastCommitResult[]> {
  const candidateProjects = await fetchCandidateProjects(opts);
  const limit = pLimit(opts.concurrency ?? 5);
  const progress = { done: 0, total: candidateProjects.length };

  return Promise.all(
    candidateProjects.map((project) => limit(() => processRepo(project, opts, progress))),
  );
}
