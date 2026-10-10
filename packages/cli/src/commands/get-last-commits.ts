import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  getLastCommits,
  logger,
  flushLogs,
  type LastCommitReport,
  type LastCommitReportRepository,
  type LastCommitResult,
  type RepoInfo,
} from '@gitlab-analyzer/core';
import {
  type RepoTiming,
  type SearchMetrics,
  type SearchProjectsItem,
} from '@gitlab-analyzer/core/internal';
import { applyApiAccess } from '../utils/api-access.ts';
import {
  resolveGetLastCommitsOptions,
  type GetLastCommitsCliOptions,
  type ResolvedGetLastCommitsOptions,
} from '../utils/options.ts';
import { fetchRepoList, resolveReposToScan } from './find-matches.ts';
import { progress, renderProgressFrame } from '../utils/progress.ts';
import {
  assertFormatPathConsistency,
  formatDate,
  isBranchMissingError,
  printRunSummary,
  renderGetLastCommitsTxt,
  resolveOutputPath,
} from '../utils/report.ts';

/**
 * Fail fast on a syntactically invalid `--file` glob (spec: unbalanced
 * brackets/braces/parens → stderr error + exit code 1 BEFORE any repository
 * is processed). picomatch itself silently accepts malformed patterns (they
 * match nothing) — this catches the obvious syntax errors the spec names.
 *
 * Deliberately lenient (no false positives on legal patterns): a closer
 * without a matching opener is a LITERAL in glob semantics (`data].txt`,
 * `[a)b]`), so only closers that close a real opener are counted; the error
 * fires only when an opener remains unclosed at end of pattern.
 */
export function assertValidGlob(pattern: string): void {
  const open: Record<'[' | '{' | '(', number> = { '[': 0, '{': 0, '(': 0 };
  const closerToOpener: Record<string, '[' | '{' | '('> = { ']': '[', '}': '{', ')': '(' };
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i++; // escaped next char — never a bracket
      continue;
    }
    if (ch === '[' || ch === '{' || ch === '(') {
      open[ch]++;
    } else if (ch in closerToOpener && open[closerToOpener[ch]] > 0) {
      open[closerToOpener[ch]]--;
    }
    // A closer with no open counterpart is a literal — not an error.
  }
  const unclosed = Object.entries(open).find(([, n]) => n > 0);
  if (unclosed !== undefined) {
    throw new Error(`Invalid --file glob pattern "${pattern}": unclosed "${unclosed[0]}".`);
  }
}

/**
 * Assemble the report: `metadata` from the resolved CLI options (`branch` is
 * the `-b` value or `null` — the effective branch is per-repo), and EVERY
 * repo returned by core with `branchExists` computed in the CLI via
 * `isBranchMissingError` (heuristic — same split as find-matches/fetch-files).
 * `failed` comes straight from core.
 */
function buildReport(
  resolved: ResolvedGetLastCommitsOptions,
  results: LastCommitResult[],
): LastCommitReport {
  const repositories: LastCommitReportRepository[] = results.map((r) => ({
    ...r,
    branchExists: r.error === null || !isBranchMissingError(r.error),
  }));
  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      branch: resolved.branch ?? null,
      file: resolved.file ?? null,
      repoNameFilter: resolved.repoNameFilter ?? null,
      excludeRepos: resolved.excludeRepos,
    },
    repositories,
  };
}

/**
 * Run the scan with live progress: loader animated by redrawing the same
 * label, pinned as the final frame when the last repo finishes.
 */
async function runWithProgress(
  resolved: ResolvedGetLastCommitsOptions,
  filtered: SearchProjectsItem[],
  selectedRepos: RepoInfo[] | undefined,
  repos: RepoInfo[],
  metrics: SearchMetrics,
): Promise<LastCommitResult[]> {
  const doneRef = { current: 0 };
  const scannedCount = selectedRepos?.length ?? repos.length;
  const totalRef = { current: scannedCount };
  // Last *started* repo (scan is parallel; live line shows what's underway now).
  let lastStartedRepo: string | undefined;

  const currentFrame = (): string =>
    renderProgressFrame(doneRef.current, totalRef.current, lastStartedRepo);

  const spinnerTimer = setInterval(() => {
    progress.spin(currentFrame());
  }, 150);

  try {
    logger.info(
      `Starting last-commit scan across ${scannedCount} repositories… (concurrency=${resolved.concurrency})`,
    );
    const results = await getLastCommits({
      branch: resolved.branch,
      file: resolved.file,
      repoNameFilter: resolved.repoNameFilter,
      excludeRepos: resolved.excludeRepos,
      selectedRepos,
      projects: filtered,
      concurrency: resolved.concurrency,
      metrics,
      onRepoStart: (repo) => {
        lastStartedRepo = repo;
        progress.spin(currentFrame());
      },
      onProgress: (done, total, _currentRepo, _error) => {
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
    logger.success('Last-commit scan finished.');
    return results;
  } finally {
    // Both normal path (onProgress already finished) and exceptional path.
    clearInterval(spinnerTimer);
    progress.clear();
  }
}

/**
 * Write the `--metrics-file` NDJSON (run / one-repo-per-line / summary). Same
 * record kinds as find-matches'/fetch-files'. A write error is a warning,
 * never fatal — the report is already written.
 */
async function writeMetricsFile(
  startedAt: Date,
  metrics: SearchMetrics,
  heapBefore: number,
  resolved: ResolvedGetLastCommitsOptions,
  reason: 'complete' | 'cancel' | 'no-repos',
): Promise<void> {
  if (!resolved.metricsFile) {
    return;
  }

  const totalHeapGrowthBytes = process.memoryUsage().heapUsed - heapBefore;
  metrics.summary.totalHeapGrowthBytes = totalHeapGrowthBytes;

  const totalWallMs = Date.now() - startedAt.getTime();
  const repoRows = metrics.perRepo;
  const totalPerRepoMs = repoRows.reduce((acc, t) => acc + t.totalMs, 0);
  const repos = repoRows.length;
  const ok = repoRows.filter((t) => t.error === undefined).length;
  const errored = repos - ok;
  const max = repoRows.reduce<RepoTiming>(
    (acc, t) => (acc === undefined || t.totalMs > acc.totalMs ? t : (acc as RepoTiming)),
    undefined as unknown as RepoTiming,
  );

  const lines = [
    {
      t: 'run',
      exitReason: reason,
      listMs: metrics.list.listMs,
      pagesFetched: metrics.list.pagesFetched,
      reposFound: metrics.list.reposFound,
      totalWallMs,
      totalPerRepoMs,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    },
    ...repoRows.map((t) => ({
      t: 'repo',
      projectId: t.projectId,
      projectName: t.projectName,
      totalMs: t.totalMs,
      filesScanned: t.filesScanned,
      filesMatched: t.filesMatched,
      error: t.error ?? null,
    })),
    {
      t: 'summary',
      exitReason: reason,
      repos,
      ok,
      errored,
      totalWallMs,
      totalPerRepoMs,
      avgRepoMs: repos > 0 ? totalPerRepoMs / repos : 0,
      maxRepoMs: max?.totalMs ?? 0,
      maxRepoName: max?.projectName ?? null,
      totalHeapGrowthBytes,
    },
  ].map((r) => JSON.stringify(r));

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
 * Internal: shared implementation invoked by the commander action handler.
 * Exported so tests can drive the full pipeline (resolve options → fetch repo
 * list → scan → build report → write output) without spawning a child
 * process.
 *
 * The config file is NEVER read (design D5): options resolve from CLI flags
 * and built-in defaults only; the token comes from CLI → env.
 *
 * @returns Object containing the parsed report and the resolved output path.
 * @throws {Error} When required options cannot be resolved, when `--format`
 *   conflicts with an explicit `--output` path extension, or when `--file` is
 *   a syntactically invalid glob (all before any repository is processed).
 */
export async function runGetLastCommits(
  opts: GetLastCommitsCliOptions,
): Promise<{ report: LastCommitReport; outputPath: string }> {
  // Run-scope timing anchor. Must be the FIRST statement so metrics capture
  // the whole run.
  const startedAt = new Date();

  // No loadConfig — this command deliberately reads no config file (D5).
  const resolution = resolveGetLastCommitsOptions(opts);
  if (!resolution.ok) {
    const lines = resolution.errors
      .map((e) => `  - ${e.field}: ${e.message}`)
      .join('\n');
    throw new Error(`Cannot run get-last-commits — missing required options:\n${lines}`);
  }
  const resolved = resolution.resolved;
  await applyApiAccess(resolved);

  // Fail-fast validations BEFORE any repository is processed (spec).
  if (resolved.file !== undefined) {
    assertValidGlob(resolved.file);
  }
  assertFormatPathConsistency(resolved.output, resolved.format);

  const metrics: SearchMetrics = {
    list: { listMs: 0, pagesFetched: 0, reposFound: 0 },
    perRepo: [],
    summary: {},
  };
  const heapBefore = process.memoryUsage().heapUsed;
  const writeSummary = (reason: 'complete' | 'cancel' | 'no-repos') =>
    writeMetricsFile(startedAt, metrics, heapBefore, resolved, reason);

  const allProjects = await fetchRepoList(resolved.repoNameFilter, metrics);
  const { repos, filtered, selectedRepos } = await resolveReposToScan(
    allProjects,
    resolved,
    writeSummary,
  );

  const results = await runWithProgress(resolved, filtered, selectedRepos, repos, metrics);

  // Per-repo warns (same UX contract as fetch-files): a 404-like error most
  // likely means the resolved branch does not exist.
  for (const repo of results) {
    if (repo.error === null) continue;
    if (isBranchMissingError(repo.error)) {
      logger.warn(
        `${repo.projectName}: branch "${repo.branch}" likely does not exist (${repo.error})`,
      );
    } else {
      logger.warn(`${repo.projectName}: ${repo.error}`);
    }
  }

  const report = buildReport(resolved, results);

  const payload =
    resolved.format === 'txt'
      ? renderGetLastCommitsTxt(report)
      : JSON.stringify(report, null, 2);
  const outputPath = resolveOutputPath(
    resolved.output,
    resolved.format,
    formatDate(),
    'get-last-commits-results-',
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, payload, 'utf-8');

  printRunSummary(report.repositories, outputPath);
  await writeSummary('complete');
  await flushLogs();

  if (resolved.stdout) {
    process.stdout.write(`${payload}\n`);
  }

  return { report, outputPath };
}
