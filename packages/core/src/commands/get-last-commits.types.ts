import type { RepoInfo, SearchProjectsItem } from '../types.ts';
import type { SearchMetrics } from './find-matches.types.ts';

/**
 * Input options for {@link getLastCommits}.
 *
 * Only `branch`-resolution is special: the CLI may omit `branch` entirely —
 * per repo it then resolves `project.default_branch ?? 'develop'` (design
 * D5). Config never reaches core: options arrive only from the CLI layer.
 */
export type LastCommitOptions = {
  /**
   * Branch flag from the CLI (`-b`). When omitted, per-repo resolution
   * applies: `project.default_branch ?? 'develop'`.
   */
  branch?: string;
  /**
   * Glob pattern switching to per-file mode (one commits request per matched
   * path). `undefined` → HEAD mode (single tip-commit request per repo).
   */
  file?: string;
  repoNameFilter?: string;
  excludeRepos?: readonly string[];
  selectedRepos?: readonly RepoInfo[];
  /** Pre-loaded project list — skips `getAllProjects` (same semantics as `findMatches`). */
  projects?: readonly SearchProjectsItem[];
  /** Parallel repos. Default 5 — a slot holds one repo with all its per-file requests. */
  concurrency?: number;
  /** Fires once per repo (success AND failure); `error` present on repo-level failure. */
  onProgress?: (done: number, total: number, currentRepo: string, error?: string) => void;
  /** Fires before each repo starts. */
  onRepoStart?: (repo: string) => void;
  /** Shared accumulator — one per-repo entry appended per processed repo. */
  metrics?: SearchMetrics;
};

/**
 * One commit entry in {@link LastCommitResult.results}.
 * `path` is `null` in HEAD mode; the repo-relative file path in per-file mode.
 */
export type LastCommitEntry = {
  path: string | null;
  /** Full commit SHA. */
  commitId: string;
  shortId: string;
  title: string;
  authorName: string;
  /** Committer date (ISO 8601, as GitLab returns it). */
  committedDate: string;
  /** Commit permalink (`commit.web_url`). */
  webUrl: string | null;
};

/** One per-path failure in per-file mode (a failed request, NOT an empty result). */
export type LastCommitFailedPath = {
  path: string;
  error: string;
};

/**
 * Result of processing one repository. `branchExists` is deliberately NOT
 * computed here — the CLI derives it from `error` via `isBranchMissingError`
 * (same split as `fetchFiles`).
 */
export type LastCommitResult = {
  projectId: number;
  projectName: string;
  webUrl: string | null;
  /** The branch that was actually queried (post per-repo resolution). */
  branch: string;
  /** Repo-level error (unreachable project, missing branch, tree-listing failure); null on success. */
  error: string | null;
  /** Per-file mode only: paths whose commits request failed; `[]` in HEAD mode. */
  failed: LastCommitFailedPath[];
  /**
   * Per-file mode: the tree walk hit the 100-page cap — the glob was applied
   * to an INCOMPLETE file list, so results may be missing matched paths.
   * Always `false` in HEAD mode.
   */
  truncated: boolean;
  results: LastCommitEntry[];
};

/** Report-level repository entry: {@link LastCommitResult} plus the CLI-computed `branchExists`. */
export type LastCommitReportRepository = LastCommitResult & { branchExists: boolean };

/** Full CLI report shape (`{ metadata, repositories }`, same family as find-matches). */
export type LastCommitReport = {
  metadata: {
    generatedAt: string;
    /** The `-b` flag value, or `null` when not passed (branch is per-repo). */
    branch: string | null;
    /** The `--file` glob, or `null` in HEAD mode. */
    file: string | null;
    repoNameFilter: string | null;
    excludeRepos: string[];
  };
  repositories: LastCommitReportRepository[];
};
