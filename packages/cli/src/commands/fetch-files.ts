import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { green, yellow } from 'colorette';
import {
  fetchFiles,
  loadConfig,
  logger,
  MAX_EMBED_BYTES,
  type FetchFilesResult,
  type FetchedRepo,
  type RepoInfo,
  type SaveFileInput,
  type SaveFileResult,
} from '@gitlab-analyzer/core';
import {
  type RepoTiming,
  type SearchMetrics,
  type SearchProjectsItem,
} from '@gitlab-analyzer/core/internal';
import {
  resolveFetchFilesOptions,
  type FetchFilesCliOptions,
  type FetchFilesOutputFormat,
  type ResolvedFetchFilesOptions,
} from '../utils/options.ts';
import { applyApiAccess } from '../utils/api-access.ts';
import { isUnsafeRepoPath, timestampDirName, withCollisionSuffix } from '../utils/fetch-layout.ts';
import { fetchRepoList, resolveReposToScan } from './find-matches.ts';
import { progress, renderProgressFrame } from '../utils/progress.ts';
import { isBranchMissingError } from '../utils/report.ts';

const MB = 1_048_576;

const toMb = (bytes: number): string => (bytes / MB).toFixed(1);

/** One meta.repo entry (FetchedRepo minus `truncated`/`files`, plus `branchExists`). */
export type FetchFilesMetaRepo = {
  projectId: number;
  projectName: string;
  webUrl: string | null;
  branch: string;
  status: 'fetched' | 'not-found' | 'partial' | 'error';
  branchExists: boolean;
  filesTotal: number;
  filesFetched: number;
  filesFailed: number;
  error: string | null;
};

/** One meta.files[] entry (FetchedFile minus `content`, plus `storage`). */
export type FetchFilesMetaFile = {
  projectId: number;
  repo: string;
  branch: string;
  path: string;
  bytes: number | null;
  storage: 'json' | 'file' | 'ndjson' | null;
  savedAs: string | null;
  status: 'fetched' | 'binary' | 'failed' | 'large';
  error: string | null;
};

/** meta.json written into the results directory after every repo finishes. */
export type FetchFilesMeta = {
  generatedAt: string;
  branch: string;
  patterns: string[];
  format: FetchFilesOutputFormat;
  repos: FetchFilesMetaRepo[];
  files: FetchFilesMetaFile[];
};

/** CLI-side per-file override recorded by the saveFile hook. */
type FileOverride = {
  status?: 'failed';
  error?: string;
  /** Counted byte total for a consumed large stream (FetchedFile.bytes is null). */
  bytes?: number;
};

/**
 * Build the saveFile persistence hook + its state for the run: per-file meta
 * overrides, collision maps, the ndjson index append queue, and a per-project
 * byte accumulator for the metrics file.
 */
function createSaveFile(resolved: ResolvedFetchFilesOptions, resultsDir: string): {
  saveFile: (input: SaveFileInput) => Promise<SaveFileResult>;
  overrides: Map<string, FileOverride>;
  bytesByProject: Map<number, number>;
  flushNdjson: () => Promise<void>;
} {
  // Keyed `${projectId}:${path}` — unique per repo file.
  const overrides = new Map<string, FileOverride>();
  const keyOf = (input: SaveFileInput): string => `${input.projectId}:${input.path}`;
  const bytesByProject = new Map<number, number>();
  const addBytes = (input: SaveFileInput, bytes: number): void => {
    bytesByProject.set(input.projectId, (bytesByProject.get(input.projectId) ?? 0) + bytes);
  };

  // json/txt: binary/large go to <resultsDir>/<repo>/<path>; taken names per
  // target directory (two repos with the same name can share the subtree root).
  const dirTaken = new Map<string, Set<string>>();

  // ndjson: everything lands flat in resultsDir; reserve the meta/index names
  // so a repo file can never clobber them.
  const ndTaken = new Set<string>(['meta.json', 'results.ndjson']);
  const ndjsonPath = join(resultsDir, 'results.ndjson');
  let ndQueue = Promise.resolve();
  const flushNdjson = (): Promise<void> => ndQueue;

  const consumeStreamTo = async (data: Readable, target: string): Promise<number> => {
    let counted = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        counted += chunk.length;
        cb(null, chunk);
      },
    });
    await pipeline(data, counter, createWriteStream(target));
    return counted;
  };

  const markUnsafe = (input: SaveFileInput): void => {
    logger.warn(`${input.repo}/${input.path}: unsafe path — файл не сохранён`);
    overrides.set(keyOf(input), { status: 'failed', error: 'unsafe path' });
  };

  // json/txt: <resultsDir>/<repo>/<path> for binary/large; fetched text is
  // embedded by the caller (no write here). Returns the '/'-separated
  // relative savedAs.
  const writeSeparated = async (input: SaveFileInput): Promise<string> => {
    const segments = input.path.split('/');
    const dir = join(resultsDir, input.repo, ...segments.slice(0, -1));
    const taken = dirTaken.get(dir) ?? new Set<string>();
    dirTaken.set(dir, taken);
    const name = withCollisionSuffix(segments[segments.length - 1], taken);
    taken.add(name);
    const target = join(dir, name);
    await mkdir(dir, { recursive: true });

    let bytes = input.bytes ?? 0;
    if (input.data instanceof Readable) {
      bytes = await consumeStreamTo(input.data, target);
      // FetchedFile.bytes is null for large; meta takes the counted total.
      overrides.set(keyOf(input), { bytes });
      logger.warn(
        `${input.repo}/${input.path}: ${toMb(bytes)} MB > ${MAX_EMBED_BYTES / MB} MB — сохранён на диск, в отчёт не встроен`,
      );
    } else {
      await writeFile(target, input.data);
      logger.warn(
        `Binary file — saved separately: ${input.repo}/${input.path} (${bytes} bytes)`,
      );
    }
    addBytes(input, bytes);
    return [input.repo, ...segments.slice(0, -1), name].join('/');
  };

  // ndjson: every non-failed file (fetched/binary/large) is written flat by
  // basename, and an index line is appended to results.ndjson.
  const saveNdjson = async (input: SaveFileInput): Promise<string | null> => {
    if (isUnsafeRepoPath(input.path)) {
      markUnsafe(input);
      return null;
    }
    const base = basename(input.path);
    const name = withCollisionSuffix(base, ndTaken);
    if (name !== base) {
      logger.warn(`Имя "${base}" уже занято — используется ${name} (projectId ${input.projectId})`);
    }
    ndTaken.add(name);
    const target = join(resultsDir, name);

    let bytes = input.bytes ?? 0;
    if (input.data instanceof Readable) {
      bytes = await consumeStreamTo(input.data, target);
      // FetchedFile.bytes is null for large; meta takes the counted total.
      overrides.set(keyOf(input), { bytes });
      logger.warn(
        `${input.repo}/${input.path}: ${toMb(bytes)} MB > ${MAX_EMBED_BYTES / MB} MB — сохранён на диск, в отчёт не встроен`,
      );
    } else {
      await writeFile(target, input.data);
      if (input.status === 'binary') {
        logger.warn(
          `Binary file — saved separately: ${input.repo}/${input.path} (${bytes} bytes)`,
        );
      }
    }
    addBytes(input, bytes);

    const line = JSON.stringify({
      projectId: input.projectId,
      repo: input.repo,
      branch: input.branch,
      path: input.path,
      bytes,
      savedAs: name,
    });
    // Serialized append queue: concurrent saveFile calls never interleave lines.
    // A failed append is a warning, never fatal (meta still lists the file).
    ndQueue = ndQueue
      .then(async () => {
        await appendFile(ndjsonPath, `${line}\n`, 'utf-8');
      })
      .catch((err: unknown) => {
        logger.warn(
          `Failed to append to results.ndjson: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    return name;
  };

  const saveFile = async (input: SaveFileInput): Promise<SaveFileResult> => {
    if (resolved.format === 'ndjson') {
      return { savedAs: await saveNdjson(input) };
    }
    // json/txt: fetched text is embedded in <repo>.json / results.txt later.
    if (input.status === 'fetched') {
      addBytes(input, input.bytes ?? 0);
      return { savedAs: null };
    }
    // Trust boundary: a repo-controlled path could escape resultsDir.
    if (isUnsafeRepoPath(input.path)) {
      markUnsafe(input);
      return { savedAs: null };
    }
    return { savedAs: await writeSeparated(input) };
  };

  return { saveFile, overrides, bytesByProject, flushNdjson };
}

/**
 * Assign the per-repo `<name>.json` artifact names (collision-suffixed across
 * repos from different groups). Repos that get no artifact (not-found/error)
 * are skipped. `meta.json` is reserved up front.
 */
function assignJsonNames(result: FetchFilesResult): Map<number, string> {
  const taken = new Set<string>(['meta.json']);
  const names = new Map<number, string>();
  for (const repo of result.repos) {
    if (repo.status === 'not-found' || repo.status === 'error') continue;
    const base = `${repo.projectName}.json`;
    const name = withCollisionSuffix(base, taken);
    if (name !== base) {
      logger.warn(`Имя "${base}" уже занято — используется ${name} (projectId ${repo.projectId})`);
    }
    taken.add(name);
    names.set(repo.projectId, name);
  }
  return names;
}

function buildMeta(
  resolved: ResolvedFetchFilesOptions,
  result: FetchFilesResult,
  overrides: Map<string, FileOverride>,
  jsonNames: Map<number, string> | undefined,
): { meta: FetchFilesMeta; totalBytes: number } {
  const repos = result.repos.map((r) => {
    // Unsafe files arrive as `fetched` from core; the CLI refused to persist
    // them, so the repo drops to `partial` in the meta it owns.
    const refused = r.files.some(
      (f) => overrides.get(`${f.projectId}:${f.path}`)?.status === 'failed',
    );
    const status = r.status === 'fetched' && refused ? ('partial' as const) : r.status;
    return {
      projectId: r.projectId,
      projectName: r.projectName,
      webUrl: r.webUrl,
      branch: r.branch,
      status,
      branchExists: r.error === null,
      filesTotal: r.filesTotal,
      filesFetched: r.filesFetched,
      filesFailed: r.filesFailed,
      error: r.error,
    };
  });

  let totalBytes = 0;
  const files: FetchFilesMetaFile[] = result.repos.flatMap((r) =>
    r.files.map((f) => {
      const o = overrides.get(`${f.projectId}:${f.path}`);
      const status = o?.status ?? f.status;
      const bytes = o?.bytes ?? f.bytes;
      if (bytes !== null) {
        totalBytes += bytes;
      }
      const storage: FetchFilesMetaFile['storage'] =
        status === 'failed'
          ? null
          : resolved.format === 'ndjson'
            ? 'ndjson'
            : status === 'fetched' && resolved.format === 'json'
              ? 'json'
              : 'file';
      const savedAs: string | null =
        status === 'failed'
          ? null
          : f.status === 'fetched'
            ? resolved.format === 'json'
              ? (jsonNames?.get(f.projectId) ?? null)
              : resolved.format === 'txt'
                ? 'results.txt'
                : f.savedAs
            : f.savedAs;
      return {
        projectId: f.projectId,
        repo: f.repo,
        branch: f.branch,
        path: f.path,
        bytes,
        storage,
        savedAs,
        status,
        error: o?.error ?? f.error,
      };
    }),
  );

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      branch: resolved.branch,
      patterns: resolved.patterns,
      format: resolved.format,
      repos,
      files,
    },
    totalBytes,
  };
}

/** Write one `<name>.json` artifact per fetchable repo ({repo, projectId, webUrl, branch, files[]}). */
async function writeRepoJsonFiles(
  resultsDir: string,
  result: FetchFilesResult,
  overrides: Map<string, FileOverride>,
  jsonNames: Map<number, string>,
): Promise<void> {
  for (const repo of result.repos) {
    const name = jsonNames.get(repo.projectId);
    if (name === undefined) {
      continue; // not-found / error repos get no artifact
    }
    const payload = {
      repo: repo.projectName,
      projectId: repo.projectId,
      webUrl: repo.webUrl,
      branch: repo.branch,
      files: repo.files.map((f) => ({
        path: f.path,
        bytes: overrides.get(`${f.projectId}:${f.path}`)?.bytes ?? f.bytes,
        content: f.content,
      })),
    };
    await writeFile(join(resultsDir, name), JSON.stringify(payload, null, 2), 'utf-8');
  }
}
function renderResultsTxt(result: FetchFilesResult): string {
  const lines: string[] = [];
  for (const repo of result.repos) {
    // Error/not-found repos have no files — no txt section for them (spec §5.4).
    if (repo.files.length === 0) continue;
    lines.push(`---- ${repo.projectName} (id: ${repo.projectId}) ----`);
    if (repo.webUrl !== null) {
      lines.push(`URL: ${repo.webUrl}`);
    }
    for (const f of repo.files) {
      lines.push('');
      lines.push(f.bytes !== null ? `path: ${f.path} (${f.bytes} bytes)` : `path: ${f.path}`);
      if (f.status === 'fetched') {
        if (f.content !== null && f.content.length > 0) {
          lines.push(f.content);
        }
      } else if (f.status === 'binary') {
        lines.push(`[бинарный файл, сохранён отдельно: ${f.repo}/${f.path}]`);
      } else if (f.status === 'large') {
        lines.push(`[файл > ${MAX_EMBED_BYTES / MB} МБ, сохранён отдельно: ${f.repo}/${f.path}]`);
      } else {
        lines.push(`[файл не скачан: ${f.error ?? 'unknown error'}]`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Write the `--metrics-file` NDJSON (run / one-repo-per-line / summary) for
 * `fetch-files`. Same shape as find-matches', but per-repo records carry
 * `filesFound/filesFetched/filesFailed/bytesTotal` instead of the
 * download/unzip/scan phases. `bytesTotal` comes from the saveFile hook's
 * accumulator (raw FetchedFile.bytes is null for large streams). A write
 * error is a warning, never fatal.
 */
async function writeSummaryRecord(
  startedAt: Date,
  metrics: SearchMetrics,
  heapBefore: number,
  resolved: ResolvedFetchFilesOptions,
  repos: FetchedRepo[],
  bytesByProject: Map<number, number>,
  reason: 'complete' | 'cancel' | 'no-repos',
): Promise<void> {
  if (!resolved.metricsFile) {
    return;
  }

  const heapAfter = process.memoryUsage().heapUsed;
  const totalHeapGrowthBytes = heapAfter - heapBefore;
  metrics.summary.totalHeapGrowthBytes = totalHeapGrowthBytes;

  const totalWallMs = Date.now() - startedAt.getTime();
  const repoRows = metrics.perRepo;
  const totalPerRepoMs = repoRows.reduce((acc, t) => acc + t.totalMs, 0);
  const reposCount = repoRows.length;
  const ok = repoRows.filter((t) => t.error === undefined).length;
  const errored = reposCount - ok;
  const max = repoRows.reduce<RepoTiming | undefined>(
    (acc, t) => (acc === undefined || t.totalMs > acc.totalMs ? t : acc),
    undefined,
  );
  const filesTotal = repos.reduce((acc, r) => acc + r.filesTotal, 0);

  const timingByProjectId = new Map(repoRows.map((t) => [t.projectId, t.totalMs]));
  const runRecord = {
    t: 'run',
    exitReason: reason,
    listMs: metrics.list.listMs,
    pagesFetched: metrics.list.pagesFetched,
    reposFound: metrics.list.reposFound,
    totalWallMs,
    totalPerRepoMs,
    filesTotal,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
  };
  const repoRecords = repos.map((r) => ({
    t: 'repo',
    projectId: r.projectId,
    projectName: r.projectName,
    totalMs: timingByProjectId.get(r.projectId) ?? 0,
    filesFound: r.filesTotal,
    filesFetched: r.filesFetched,
    filesFailed: r.filesFailed,
    bytesTotal: bytesByProject.get(r.projectId) ?? 0,
    error: r.error,
  }));
  const summaryRecord = {
    t: 'summary',
    exitReason: reason,
    repos: reposCount,
    ok,
    errored,
    totalWallMs,
    totalPerRepoMs,
    avgRepoMs: reposCount > 0 ? totalPerRepoMs / reposCount : 0,
    maxRepoMs: max?.totalMs ?? 0,
    maxRepoName: max?.projectName ?? null,
    totalHeapGrowthBytes,
    filesTotal,
  };

  const lines = [runRecord, ...repoRecords, summaryRecord].map((r) =>
    JSON.stringify(r),
  );
  try {
    await mkdir(dirname(resolved.metricsFile), { recursive: true });
    await writeFile(resolved.metricsFile, `${lines.join('\n')}\n`, 'utf-8');
  } catch (err) {
    logger.warn(
      `Failed to write metrics file (${resolved.metricsFile}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Run the parallel fetch with live progress: loader animated by redrawing the
 * same label, stopped (pinned as the final frame) when the last repo finishes.
 */
async function runFetchWithProgress(
  resolved: ResolvedFetchFilesOptions,
  filtered: SearchProjectsItem[],
  selectedRepos: RepoInfo[] | undefined,
  repos: RepoInfo[],
  saveFile: NonNullable<Parameters<typeof fetchFiles>[0]['saveFile']>,
  metrics: SearchMetrics,
): Promise<FetchFilesResult> {
  const doneRef = { current: 0 };
  const scannedCount = selectedRepos?.length ?? repos.length;
  const totalRef = { current: scannedCount };
  // Last *started* repo (fetch is parallel; live line shows what's underway now).
  let lastStartedRepo: string | undefined;

  const currentFrame = (): string =>
    renderProgressFrame(doneRef.current, totalRef.current, lastStartedRepo);

  const spinnerTimer = setInterval(() => {
    progress.spin(currentFrame());
  }, 150);

  try {
    logger.info(`Starting fetch across ${scannedCount} repositories… (concurrency=${resolved.concurrency})`);
    const result = await fetchFiles({
      patterns: resolved.patterns,
      branch: resolved.branch,
      repoNameFilter: resolved.repoNameFilter,
      excludeRepos: resolved.excludeRepos,
      selectedRepos,
      projects: filtered,
      fileExclude: resolved.fileExclude,
      concurrency: resolved.concurrency,
      saveFile,
      metrics,
      onRepoStart: (repo) => {
        lastStartedRepo = repo;
        progress.spin(currentFrame());
      },
      onProgress: (done, total, currentRepo, _error) => {
        doneRef.current = done;
        totalRef.current = total;
        if (done >= total) {
          // Last repo done — pin the final frame as a permanent line.
          clearInterval(spinnerTimer);
          progress.finish(currentFrame());
        } else {
          progress.spin(currentFrame());
        }
      },
    });
    logger.success('Fetch finished.');
    return result;
  } finally {
    // Both normal path (onProgress already finished) and exceptional path.
    clearInterval(spinnerTimer);
    progress.clear();
  }
}

/**
 * Internal: shared implementation invoked by the commander action handler
 * (wired in task 8). Exported so tests can drive the full pipeline (resolve
 * options → fetch repo list → fetch files → write meta + artifacts) without
 * spawning a child process.
 *
 * stdout is NEVER written — everything user-facing goes to stderr via the
 * progress renderer / logger.
 *
 * @returns The created results directory (a fresh timestamped directory).
 * @throws {Error} When one or more required options cannot be resolved.
 */
export async function runFetchFiles(
  patterns: string[],
  opts: FetchFilesCliOptions,
): Promise<{ resultsDir: string }> {
  // Run-scope timing anchor. Must be the FIRST statement so totalWallMs
  // captures the whole run (config load, list fetch, files, meta write).
  const startedAt = new Date();
  const config = await loadConfig();
  const resolution = resolveFetchFilesOptions(patterns, opts, config);
  if (!resolution.ok) {
    const lines = resolution.errors
      .map((e) => `  - ${e.field}: ${e.message}`)
      .join('\n');
    throw new Error(`Cannot run fetch-files — missing required options:\n${lines}`);
  }
  const resolved = resolution.resolved;
  await applyApiAccess(resolved);

  // Run-scope metrics accumulator + heap sampled at start (diffed at the end).
  const metrics: SearchMetrics = {
    list: { listMs: 0, pagesFetched: 0, reposFound: 0 },
    perRepo: [],
    summary: {},
  };
  const heapBefore = process.memoryUsage().heapUsed;
  let fetchedRepos: FetchedRepo[] = [];
  let bytesByProject: Map<number, number> = new Map();
  const writeSummary = (reason: 'complete' | 'cancel' | 'no-repos') =>
    writeSummaryRecord(
      startedAt,
      metrics,
      heapBefore,
      resolved,
      fetchedRepos,
      bytesByProject,
      reason,
    );

  // Handed to fetchFiles via projects so it doesn't re-fetch the list.
  const allProjects = await fetchRepoList(resolved.repoNameFilter, metrics);
  const { repos, filtered, selectedRepos } = await resolveReposToScan(
    allProjects,
    resolved,
    writeSummary,
  );

  // D8: the results directory is always a NEW timestamped directory —
  // never collides with previous runs, so no per-file clobber checks needed
  // beyond within-run collisions.
  const resultsDir = resolved.output
    ? join(resolved.output, `fetch-files-results-${timestampDirName(startedAt)}`)
    : `fetch-files-results-${timestampDirName(startedAt)}`;
  await mkdir(resultsDir, { recursive: true });

  const { saveFile, overrides, bytesByProject: bytes, flushNdjson } =
    createSaveFile(resolved, resultsDir);
  bytesByProject = bytes;

  const result = await runFetchWithProgress(
    resolved,
    filtered,
    selectedRepos,
    repos,
    saveFile,
    metrics,
  );
  fetchedRepos = result.repos;

  // Per-repo error warns: a 404-like tree error most likely means the branch
  // does not exist (same UX contract as the find-matches report).
  for (const repo of result.repos) {
    if (repo.error === null) continue;
    if (isBranchMissingError(repo.error)) {
      logger.warn(
        `${repo.projectName}: ветка "${repo.branch}", вероятно, не существует (${repo.error})`,
      );
    } else {
      logger.warn(`${repo.projectName}: ${repo.error}`);
    }
  }

  const jsonNames = resolved.format === 'json' ? assignJsonNames(result) : undefined;
  const { meta, totalBytes } = buildMeta(resolved, result, overrides, jsonNames);
  await writeFile(join(resultsDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

  if (resolved.format === 'json') {
    await writeRepoJsonFiles(resultsDir, result, overrides, jsonNames ?? new Map());
  }
  if (resolved.format === 'txt') {
    await writeFile(join(resultsDir, 'results.txt'), renderResultsTxt(result), 'utf-8');
  }
  // ndjson index lines were appended (serialized) during saveFile — drain.
  await flushNdjson();

  const totalFiles = meta.files.length;
  progress.static(''); // separator between the fetch and the summary
  progress.static(
    green(`✓ Fetched ${totalFiles} files (${result.repos.length} repos), total ${toMb(totalBytes)} MB`),
  );
  const errored = result.repos.filter((r) => r.error !== null);
  if (errored.length > 0) {
    progress.static(
      yellow(`⚠ Of which errored: ${errored.length} (${errored.map((r) => r.projectName).join(', ')})`),
    );
  }
  progress.static(`meta: ${join(resultsDir, 'meta.json')}`);

  // D17: zero files across all repos is a normal exit (meta already written).
  if (totalFiles === 0) {
    logger.warn(`No files matched the patterns across ${result.repos.length} repositories.`);
  }

  await writeSummary('complete');

  return { resultsDir };
}
