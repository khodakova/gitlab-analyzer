import type { Readable } from 'node:stream';
import pLimit from 'p-limit';
import { listRepoTreeRecursive } from '../api/repository-tree.ts';
import { fetchBlobRaw } from '../api/repository-blobs.ts';
import { getAllProjects } from '../utils/get-projects.ts';
import { logger } from '../utils/logger.ts';
import { compileMatcher } from './find-matches.ts';
import type { TreeEntry } from '../api/repository-tree.ts';
import type {
  FetchFilesOptions,
  FetchFilesResult,
  FetchedFile,
  FetchedRepo,
  RepoStatus,
  SaveFileInput,
  SaveFileResult,
} from './fetch-files.types.ts';
import type { NamedProject, RepoTiming } from './find-matches.types.ts';

// ponytail: blob читается в память целиком, лимита размера нет (решение пользователя,
// 2026-09-01); вернуть потолок / стриминговое встраивание, если в репо появятся
// многогигабайтные lock-файлы.
function readBlobToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const cleanup = (): void => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };

    const onData = (raw: Buffer | string): void => {
      chunks.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

/**
 * Load the project list (or reuse `opts.projects`) and apply the same
 * candidate filter as `findMatches`: null/empty name dropped, `excludeRepos`
 * dropped, `selectedRepos` intersection kept.
 */
async function fetchCandidateProjects(opts: FetchFilesOptions): Promise<NamedProject[]> {
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

/**
 * Fetch and process a single matched file. Never throws — all failures become
 * a `failed` FetchedFile (and a `partial` repo). Failed files never reach
 * `saveFile`.
 */
async function fetchOneFile(
  project: NamedProject,
  entry: TreeEntry,
  branch: string,
  saveFile: FetchFilesOptions['saveFile'],
): Promise<FetchedFile> {
  const base = {
    projectId: project.id,
    repo: project.name,
    branch,
    path: entry.path,
  };
  let stream: Readable;
  try {
    stream = await fetchBlobRaw(project.id, entry.id, { projectName: project.name });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Blob fetch failed: ${project.name}/${entry.path} (${message})`);
    return { ...base, bytes: null, status: 'failed', content: null, savedAs: null, error: message };
  }

  let buffer: Buffer;
  try {
    buffer = await readBlobToBuffer(stream);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Blob read failed: ${project.name}/${entry.path} (${message})`);
    return { ...base, bytes: null, status: 'failed', content: null, savedAs: null, error: message };
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    logger.warn(`Binary file — saved separately: ${project.name}/${entry.path} (${buffer.length} bytes)`);
    const input: SaveFileInput = { ...base, bytes: buffer.length, data: buffer, status: 'binary' };
    const { savedAs } = (await saveFile?.(input)) ?? ({ savedAs: null } satisfies SaveFileResult);
    return { ...base, bytes: buffer.length, status: 'binary', content: null, savedAs, error: null };
  }

  const input: SaveFileInput = { ...base, bytes: buffer.length, data: buffer, status: 'fetched' };
  const { savedAs } = (await saveFile?.(input)) ?? ({ savedAs: null } satisfies SaveFileResult);
  return { ...base, bytes: buffer.length, status: 'fetched', content: text, savedAs, error: null };
}

/** Append one per-repo timing entry to the shared accumulator (RepoTiming-compatible, phases zeroed). */
function pushRepoMetrics(metrics: FetchFilesOptions['metrics'], entry: {
  projectId: number;
  projectName: string;
  totalMs: number;
  filesScanned: number;
  filesMatched: number;
  error?: string;
}): void {
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
 * Process one repo inside a p-limit slot: list the tree, filter entries,
 * download the matching blobs. All progress reporting goes through `opts`.
 */
async function processRepo(project: NamedProject, opts: FetchFilesOptions, progress: { done: number; total: number }): Promise<FetchedRepo> {
  const branch = opts.branch;
  opts.onRepoStart?.(project.name);
  const startedAt = Date.now();

  const includeMatchers = opts.patterns.map(compileMatcher);
  const excludeMatchers = (opts.fileExclude ?? []).map(compileMatcher);
  const done = (error?: string): void => {
    progress.done++;
    opts.onProgress?.(progress.done, progress.total, project.name, error);
  };

  let tree;
  try {
    tree = await listRepoTreeRecursive(project.id, branch, { projectName: project.name });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Tree fetch failed: ${project.name} (${message})`);
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
      status: 'error',
      filesTotal: 0,
      filesFetched: 0,
      filesFailed: 0,
      error: message,
      truncated: false,
      files: [],
    };
  }

  const matched = tree.entries.filter((entry) => {
    if (entry.type !== 'blob') return false;
    const normalized = `/${entry.path}`;
    if (excludeMatchers.some((m) => m(normalized))) return false;
    return includeMatchers.some((m) => m(normalized));
  });

  const files = await Promise.all(
    matched.map((entry) => fetchOneFile(project, entry, branch, opts.saveFile)),
  );

  const filesFailed = files.filter((f) => f.status === 'failed').length;
  const status: RepoStatus =
    files.length === 0 ? 'not-found' : tree.truncated || filesFailed > 0 ? 'partial' : 'fetched';

  done();
  pushRepoMetrics(opts.metrics, {
    projectId: project.id,
    projectName: project.name,
    totalMs: Date.now() - startedAt,
    filesScanned: files.length,
    filesMatched: files.length - filesFailed,
    error: filesFailed > 0 ? `${filesFailed} file(s) failed` : undefined,
  });
  return {
    projectId: project.id,
    projectName: project.name,
    webUrl: project.web_url ?? null,
    branch,
    status,
    filesTotal: files.length,
    filesFetched: files.length - filesFailed,
    filesFailed,
    error: null,
    truncated: tree.truncated,
    files,
  };
}

/**
 * Download the files matching `patterns` from every reachable GitLab project's
 * `branch`, mirroring `findMatches` (project discovery, filters, concurrency)
 * but walking the repository tree instead of scanning archives.
 *
 * The function is pure: no file writes, no `process.exit`. Persistence is the
 * CLI's job — through the `saveFile` hook: core decides WHAT (fetched / binary
 * / failed — data is always a full Buffer), the CLI decides WHERE (format,
 * collisions, unsafe paths). The hook's `savedAs` is written back into each
 * {@link FetchedFile}. `branchExists` is NOT computed here — the CLI derives
 * it from `repo.error`.
 *
 * Repo statuses: tree fetch error → `error` (no blob fetches); zero matches
 * after filtering → `not-found`; any failed file or a truncated tree →
 * `partial`; else `fetched`.
 */
export async function fetchFiles(opts: FetchFilesOptions): Promise<FetchFilesResult> {
  const candidateProjects = await fetchCandidateProjects(opts);
  const limit = pLimit(opts.concurrency ?? 5);
  const progress = { done: 0, total: candidateProjects.length };

  const repos = await Promise.all(
    candidateProjects.map((project) => limit(() => processRepo(project, opts, progress))),
  );

  return { repos };
}
