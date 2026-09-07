import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { green, yellow } from 'colorette';
import {
  findMatches,
  loadConfig,
  logger,
  flushLogs,
  formatDuration,
  type FindMatchesOptions,
  type MatchResult,
  type RepoInfo,
} from '@gitlab-analyzer/core';
import {
  getAllProjects,
  type SearchProjectsItem,
  type SearchMetrics,
  type RepoTiming,
} from '@gitlab-analyzer/core/internal';
import { applyApiAccess } from '../utils/api-access.ts';
import { repoSelect } from '../utils/repo-select.ts';
import { progress, report, renderProgressFrame } from '../utils/progress.ts';
import {
  resolveOptions,
  type FindMatchesCliOptions,
  type OutputFilter,
  type ResolvedFindMatchesOptions,
} from '../utils/options.ts';
import {
  assertFormatPathConsistency,
  buildReport,
  formatDate,
  isBranchMissingError,
  renderReportTxt,
  resolveOutputPath,
  type Report,
  type ReportRepository,
} from '../utils/report.ts';

/**
 * Write the `--metrics-file` NDJSON (run / one-repo-per-line / summary) and
 * print the stderr metrics summary. Call on every normal exit of
 * `runFindMatches`: `complete` (after the report is written), `cancel`
 * (interactive empty selection) and `no-repos` (headless zero-repo guard).
 * A write error is a warning, never fatal — the report is already written.
 */
async function writeSummaryRecord(
  startedAt: Date,
  metrics: SearchMetrics,
  heapBefore: number,
  resolved: ResolvedFindMatchesOptions,
  reason: 'complete' | 'cancel' | 'no-repos',
): Promise<void> {
  const heapAfter = process.memoryUsage().heapUsed;
  const totalHeapGrowthBytes = heapAfter - heapBefore;
  metrics.summary.totalHeapGrowthBytes = totalHeapGrowthBytes;

  const totalWallMs = Date.now() - startedAt.getTime();
  const repoRows = metrics.perRepo;
  const totalPerRepoMs = repoRows.reduce((acc, t) => acc + t.totalMs, 0);
  const repos = repoRows.length;
  const ok = repoRows.filter((t) => t.error === undefined).length;
  const errored = repos - ok;
  const max = repoRows.reduce<RepoTiming | undefined>(
    (acc, t) => (acc === undefined || t.totalMs > acc.totalMs ? t : acc),
    undefined,
  );

  if (repos > 0) {
    const avgRepoMs = repos > 0 ? totalPerRepoMs / repos : 0;
    const heapMb = (totalHeapGrowthBytes / 1_048_576).toFixed(1);
    progress.static(
      `Metrics: ${repos} repos · list ${formatDuration(metrics.list.listMs)} (${metrics.list.pagesFetched} pg, ${metrics.list.reposFound} repos) · total ${formatDuration(totalWallMs)} · avg ${formatDuration(avgRepoMs)} · max ${max?.projectName ?? '-'} (${formatDuration(max?.totalMs ?? 0)}) · heap Δ${heapMb} MB`,
    );
  } else {
    const heapMb = (totalHeapGrowthBytes / 1_048_576).toFixed(1);
    progress.static(
      `Metrics: exit=${reason} · list ${formatDuration(metrics.list.listMs)} · total ${formatDuration(totalWallMs)} · heap Δ${heapMb} MB`,
    );
  }

  if (!resolved.metricsFile) {
    return;
  }

  const runRecord = {
    t: 'run',
    exitReason: reason,
    listMs: metrics.list.listMs,
    pagesFetched: metrics.list.pagesFetched,
    reposFound: metrics.list.reposFound,
    totalWallMs,
    totalPerRepoMs,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
  };
  const repoRecords = repoRows.map((t) => ({
    t: 'repo',
    projectId: t.projectId,
    projectName: t.projectName,
    downloadMs: t.downloadMs,
    unzipMs: t.unzipMs,
    scanMs: t.scanMs,
    totalMs: t.totalMs,
    filesScanned: t.filesScanned,
    filesMatched: t.filesMatched,
    textLength: t.textLength,
    error: t.error ?? null,
  }));
  const summaryRecord = {
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
 * Shared pre-flight for every subcommand: resolve options from
 * config/env/CLI and set up side-effects (logger, axios URL/token).
 *
 * Split out of {@link prepareRun} so other commands (e.g. `list-repos`) can
 * reuse the resolution + API-access wiring without inheriting find-matches
 * specifics — notably the `commands.find-matches.output` config default,
 * which must NOT trip `assertFormatPathConsistency` in commands that never
 * write a report.
 *
 * @param commandName - Subcommand name used in the missing-options error.
 * @param strings - Positional strings; empty only for commands that don't
 *   take any (they pass a placeholder so the required-strings check is
 *   satisfied — see `runListRepos`).
 */
export async function prepareApiAccess(
  commandName: string,
  strings: readonly string[],
  opts: FindMatchesCliOptions,
): Promise<{ resolved: ResolvedFindMatchesOptions }> {
  const config = await loadConfig();
  const resolution = resolveOptions(strings, opts, config);

  if (!resolution.ok) {
    const lines = resolution.errors
      .map((e) => `  - ${e.field}: ${e.message}`)
      .join('\n');
    throw new Error(
      `Cannot run ${commandName} — missing required options:\n${lines}`,
    );
  }

  const { resolved } = resolution;

  // Shared API-access wiring: logger + axios URL/token (moved to
  // utils/api-access.ts so other subcommands reuse it without inheriting
  // find-matches' resolveOptions / output config default).
  await applyApiAccess(resolved);

  return { resolved };
}

/**
 * find-matches pre-flight: shared option resolution + API access wiring
 * ({@link prepareApiAccess}), plus the find-matches-specific format/output
 * consistency check.
 */
async function prepareRun(
  strings: string[],
  opts: FindMatchesCliOptions,
): Promise<{ resolved: ResolvedFindMatchesOptions }> {
  const { resolved } = await prepareApiAccess('find-matches', strings, opts);

  // Format/extension consistency is validated early, before any network work —
  // a silent mismatch would otherwise waste a full scan.
  assertFormatPathConsistency(resolved.output, resolved.format);

  return { resolved };
}

export async function fetchRepoList(
  repoNameFilter: string | undefined,
  metrics: SearchMetrics,
): Promise<SearchProjectsItem[]> {
  const fetchReposTimer = setInterval(() => {
    progress.spin('Fetching repository list...');
  }, 150);

  try {
    logger.info(`Fetching repository list (repoNameFilter='${repoNameFilter ?? ''}')...`);
    const allProjects = await getAllProjects(repoNameFilter, metrics.list);
    logger.info(`Repository list fetched: ${allProjects.length}`);
    return allProjects;
  } finally {
    clearInterval(fetchReposTimer);
    progress.clear();
  }
}

// Filter the fetched repo list and decide whether/how to scan: interactive picker
// (cancel → exit 0) or headless (empty list → exit 0, else print the repo list).
// Shared by find-matches and fetch-files; the config pick keeps the contract to
// only the fields both commands share.
export async function resolveReposToScan(
  allProjects: SearchProjectsItem[],
  resolvedConfig: Pick<ResolvedFindMatchesOptions, 'excludeRepos' | 'interactive'>,
  writeSummary: (reason: 'complete' | 'cancel' | 'no-repos') => Promise<void>,
): Promise<{
  repos: RepoInfo[];
  filtered: SearchProjectsItem[];
  selectedRepos: RepoInfo[] | undefined;
}> {
  const excludeList = resolvedConfig.excludeRepos;
  const filtered = allProjects.filter(
    (project) =>
      project.name !== null &&
      project.name.length > 0 &&
      !excludeList.includes(project.name),
  );
  const repos: RepoInfo[] = filtered.map((project) => ({
    id: project.id,
    name: project.name as string,
  }));

  let selectedRepos: RepoInfo[] | undefined;
  if (resolvedConfig.interactive) {
    selectedRepos = await repoSelect(repos);

    if (selectedRepos.length === 0) {
      await writeSummary('cancel');
      report('Search cancelled: no repositories selected.');
      await flushLogs();
      process.exit(0);
    }
  } else {
    // Headless empty filter → stop early; not an error, just nothing matched.
    if (repos.length === 0) {
      logger.info('No repositories found: filters/exclusions produced no results.');
      await writeSummary('no-repos');
      await flushLogs();
      process.exit(0);
    }
    // Headless info output: show where the search will run (stderr, so stdout
    // report stays clean/pipeable).
    progress.static(''); // separator between the list-fetch and search phases
    report(`Search will run across ${repos.length} repositories:`);
    for (const repo of repos) {
      report(repo.name);
    }
  }

  return { repos, filtered, selectedRepos };
}

/**
 * Run the parallel search with live progress: per-repo errors collected via
 * `onProgress`, loader animated by redrawing the same label, stopped (pinned as
 * the final frame) when the last repo finishes.
 */
async function runSearchWithProgress(
  strings: string[],
  resolved: ResolvedFindMatchesOptions,
  filtered: SearchProjectsItem[],
  selectedRepos: RepoInfo[] | undefined,
  repos: RepoInfo[],
  metrics: SearchMetrics,
): Promise<{ results: MatchResult[]; repoErrors: Map<string, string> }> {
  const repoErrors = new Map<string, string>();
  // Last *started* repo (analysis is parallel; live line shows what's underway now).
  let lastStartedRepo: string | undefined;

  const doneRef = { current: 0 };
  const scannedCount = selectedRepos?.length ?? repos.length;
  const totalRef = { current: scannedCount };

  const currentFrame = (): string =>
    renderProgressFrame(doneRef.current, totalRef.current, lastStartedRepo);

  // Animates the loader: redraws the same label so ProgressRenderer.spin advances the glyph.
  const spinnerTimer = setInterval(() => {
    progress.spin(currentFrame());
  }, 150);

  const findOpts: FindMatchesOptions = {
    searchStrings: strings,
    branch: resolved.branch,
    repoNameFilter: resolved.repoNameFilter,
    excludeRepos: resolved.excludeRepos,
    selectedRepos,
    projects: filtered,
    fileInclude: resolved.fileInclude,
    fileExclude: resolved.fileExclude,
    concurrency: resolved.concurrency,
    metrics,
    onRepoStart: (repo) => {
      lastStartedRepo = repo;
      progress.spin(currentFrame());
    },
    onProgress: (done, total, currentRepo, error) => {
      if (error !== undefined) {
        repoErrors.set(currentRepo, error);
      }
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
  };

  let results: MatchResult[];
  try {
    logger.info(`Starting search across ${scannedCount} repositories… (concurrency=${resolved.concurrency})`);
    results = await findMatches(findOpts);
    logger.success('Search finished.');
  } finally {
    // Both normal path (onProgress already finished) and exceptional path.
    clearInterval(spinnerTimer);
    progress.clear();
  }

  return { results, repoErrors };
}

// Build the final repositories[]: results first, then zero-match/error scanned repos.
function assembleReport(
  results: MatchResult[],
  repoErrors: Map<string, string>,
  filtered: SearchProjectsItem[],
  selectedRepos: RepoInfo[] | undefined,
  repos: RepoInfo[],
): ReportRepository[] {
  const scanned = selectedRepos ?? repos;
  const repoInfoByName = new Map<string, { id: number; webUrl: string | null }>();
  for (const p of filtered) {
    if (p.name && p.web_url !== null) {
      repoInfoByName.set(p.name, { id: p.id, webUrl: p.web_url ?? null });
    }
  }

  // Results first, then zero-match/error scanned repos, so report lists everything searched.
  const repositories: ReportRepository[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (seen.has(r.projectName)) continue;
    seen.add(r.projectName);
    const error = repoErrors.get(r.projectName) ?? null;
    repositories.push({
      projectId: r.projectId,
      projectName: r.projectName,
      projectDescription: r.projectDescription,
      webUrl: repoInfoByName.get(r.projectName)?.webUrl ?? null,
      branchExists: error === null || !isBranchMissingError(error),
      error,
      resultsLength: r.resultsLength,
      results: r.results,
    });
  }
  for (const repo of scanned) {
    if (seen.has(repo.name)) continue;
    seen.add(repo.name);
    const error = repoErrors.get(repo.name) ?? null;
    repositories.push({
      projectId: repo.id,
      projectName: repo.name,
      projectDescription: null,
      webUrl: repoInfoByName.get(repo.name)?.webUrl ?? null,
      branchExists: error === null || !isBranchMissingError(error),
      error,
      resultsLength: 0,
      results: [],
    });
  }
  return repositories;
}

/**
 * Filter the assembled repository list according to `--output-filter`.
 *
 * - `all` → unchanged (every scanned repo, including errors).
 * - `found` → only repos with `resultsLength > 0` (errors excluded).
 * - `not-found` → only repos with `resultsLength === 0` (errors excluded).
 *
 * Errored repos are dropped from both `found` and `not-found` — an error is
 * not "no results", it means the repo was never scanned.
 */
function applyOutputFilter(
  repositories: ReportRepository[],
  outputFilter: OutputFilter,
): ReportRepository[] {
  if (outputFilter === 'all') return repositories;
  return repositories.filter((repo) => {
    if (repo.error !== null) return false;
    return outputFilter === 'found'
      ? repo.resultsLength > 0
      : repo.resultsLength === 0;
  });
}
// recursively), and return both path and payload (payload for optional --stdout).
async function writeOutput(
  resolved: ResolvedFindMatchesOptions,
  reportPayload: Report,
  strings: string[],
  metrics: SearchMetrics,
): Promise<{ outputPath: string; payload: string }> {
  // E.14 — total files that passed both filters across all repos; stdout-only.
  const totalFilesScanned = metrics.perRepo.reduce(
    (acc, t) => acc + t.filesScanned,
    0,
  );

  const payload =
    resolved.format === 'txt'
      ? renderReportTxt(reportPayload, totalFilesScanned)
      : JSON.stringify(reportPayload, null, 2);

  const outputPath = resolveOutputPath(resolved.output, resolved.format, formatDate());
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, payload, 'utf-8');

  return { outputPath, payload };
}

// Final run-scope summary block on stderr: scanned count, optional errors, report path.
function printRunSummary(
  repositories: ReportRepository[],
  outputPath: string,
): void {
  const errored = repositories.filter((r) => r.error !== null);
  progress.static(''); // separator between the search and the summary
  progress.static(green(`✓ Scanned repositories: ${repositories.length}`));
  if (errored.length > 0) {
    progress.static(yellow(`⚠ Of which errored: ${errored.length} (${errored.map((r) => r.projectName).join(', ')})`));
  }
  progress.static(green(`✓ Report: ${outputPath}`));
}

/**
 * Internal: shared implementation invoked by the commander action handler.
 *
 * Exported separately so tests can drive the full pipeline (resolve options →
 * fetch repo list → run search → build report → write output) without
 * spawning a child process.
 *
 * @returns Object containing the parsed report and the resolved output path.
 * @throws {Error} When one or more required options cannot be resolved from
 *   any source, or when `--format` conflicts with an explicit `--output`
 *   path extension.
 */
export async function runFindMatches(
  strings: string[],
  opts: FindMatchesCliOptions,
): Promise<{ report: Report; outputPath: string }> {
  // Run-scope timing anchor. Must be the FIRST statement so totalWallMs
  // captures the whole run (config load, list fetch, search, report write).
  const startedAt = new Date();
  const { resolved } = await prepareRun(strings, opts);

  // Run-scope metrics accumulator + heap sampled at start (diffed at the end).
  const metrics: SearchMetrics = {
    list: { listMs: 0, pagesFetched: 0, reposFound: 0 },
    perRepo: [],
    summary: {},
  };
  const heapBefore = process.memoryUsage().heapUsed;
  const writeSummary = (reason: 'complete' | 'cancel' | 'no-repos') =>
    writeSummaryRecord(startedAt, metrics, heapBefore, resolved, reason);

  // Handed to findMatches via projects so it doesn't re-fetch the list.
  const allProjects = await fetchRepoList(resolved.repoNameFilter, metrics);
  const { repos, filtered, selectedRepos } = await resolveReposToScan(
    allProjects,
    resolved,
    writeSummary,
  );

  const { results, repoErrors } = await runSearchWithProgress(
    strings,
    resolved,
    filtered,
    selectedRepos,
    repos,
    metrics,
  );

  const repositories = assembleReport(results, repoErrors, filtered, selectedRepos, repos);
  const filteredRepos = applyOutputFilter(repositories, resolved.outputFilter);
  if (resolved.outputFilter !== 'all' && filteredRepos.length === 0) {
    progress.static(
      yellow(`No repositories matched --output-filter ${resolved.outputFilter}; the report is empty.`),
    );
  }
  const report = buildReport(resolved, strings, filteredRepos);
  const { outputPath, payload } = await writeOutput(resolved, report, strings, metrics);

  printRunSummary(repositories, outputPath);
  await writeSummary('complete');

  if (resolved.stdout) {
    process.stdout.write(`${payload}\n`);
  }

  return { report, outputPath };
}
