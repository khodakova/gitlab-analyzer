import type { RepoInfo, SearchProjectsItem } from '../types.ts';
import type { SearchMetrics } from './find-matches.types.ts';

/** Outcome of a single file fetch inside {@link FetchedRepo.files}. */
export type FetchedFileStatus = 'fetched' | 'binary' | 'failed';

/** One processed file (all files of a repo end up here: fetched + binary + failed). */
export type FetchedFile = {
  projectId: number;
  repo: string;
  branch: string;
  /** Path in the repo, `/`-separated, WITHOUT the leading slash (tree-API form). */
  path: string;
  /** null only for `failed` (the blob was never fully read). */
  bytes: number | null;
  status: FetchedFileStatus;
  /** Non-empty only for embedded text (`fetched`). */
  content: string | null;
  /** Actual on-disk name, from the `saveFile` hook. */
  savedAs: string | null;
  error: string | null;
};

/** Outcome of a whole repo walk. `branchExists` is deliberately NOT here — the CLI derives it from `error`. */
export type RepoStatus = 'fetched' | 'not-found' | 'partial' | 'error';

/** Result of processing one repository. */
export type FetchedRepo = {
  projectId: number;
  projectName: string;
  webUrl: string | null;
  branch: string;
  status: RepoStatus;
  filesTotal: number;
  filesFetched: number;
  filesFailed: number;
  error: string | null;
  /** The tree-pagination guard fired — the file list may be incomplete. */
  truncated: boolean;
  files: FetchedFile[];
};

/** Payload handed to the `saveFile` hook. Failed files never reach it. */
export type SaveFileInput = {
  projectId: number;
  repo: string;
  branch: string;
  /** Path in the repo (tree-API form, no leading slash). */
  path: string;
  /** buffer.length — known for every file that reaches the hook. */
  bytes: number;
  /** Full file content (no size cap — deliberate user decision, 2026-09-01). */
  data: Buffer;
  status: 'fetched' | 'binary';
};

export type SaveFileResult = { savedAs: string | null };

/** Input options for {@link fetchFiles}. */
export type FetchFilesOptions = {
  /** Glob patterns for the files to download (positional CLI args). */
  patterns: readonly string[];
  branch: string;
  repoNameFilter?: string;
  excludeRepos?: readonly string[];
  selectedRepos?: readonly RepoInfo[];
  /** Pre-loaded project list — skips `getAllProjects` (same semantics as `findMatches`). */
  projects?: readonly SearchProjectsItem[];
  /** Force-skip patterns; wins over `patterns` (same matcher as findMatches). */
  fileExclude?: readonly string[];
  /** Parallel repos. Default 5. */
  concurrency?: number;
  /**
   * Persistence hook. Core decides WHAT (status + Buffer vs Readable), the
   * caller decides WHERE (format, collisions, unsafe paths). `savedAs` from
   * the result is written back into the matching {@link FetchedFile}.
   */
  saveFile?: (input: SaveFileInput) => Promise<SaveFileResult> | SaveFileResult;
  /** Fires once per repo (success AND failure); `error` present on failure. */
  onProgress?: (done: number, total: number, currentRepo: string, error?: string) => void;
  /** Fires before each repo starts. */
  onRepoStart?: (repo: string) => void;
  /** Shared accumulator — one per-repo entry appended per processed repo. */
  metrics?: SearchMetrics;
};

export type FetchFilesResult = { repos: FetchedRepo[] };
