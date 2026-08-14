import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { green, yellow } from 'colorette';
import {
  findStrings,
  loadConfig,
  configureLogger,
  logger,
  flushLogs,
  type FindStringsOptions,
  type MatchResult,
  type RepoInfo,
} from '@gitlab-analyzer/core';
import {
  axiosInstance,
  getAllProjects,
  type SearchProjectsItem,
} from '@gitlab-analyzer/core/internal';
import { repoSelect } from '../utils/repo-select.ts';
import { progress, report, renderProgressFrame } from '../utils/progress.ts';
import {
  resolveOptions,
  type FindStringsCliOptions,
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
 * Internal: shared implementation invoked by the commander action handler.
 *
 * Exported separately so tests can drive the full pipeline (resolve options →
 * fetch repo list → run search → build report → write output) without
 * spawning a child process.
 *
 * @returns Object containing the parsed report and the resolved output path
 *   (or `undefined` if nothing was written to disk).
 * @throws {Error} When one or more required options cannot be resolved from
 *   any source, or when `--format` conflicts with an explicit `--output`
 *   path extension.
 */
export async function runFindStrings(
  strings: string[],
  opts: FindStringsCliOptions,
): Promise<{ report: Report; outputPath: string | undefined }> {
  const config = await loadConfig();
  const resolution = resolveOptions(strings, opts, config);

  if (!resolution.ok) {
    const lines = resolution.errors
      .map((e) => `  - ${e.field}: ${e.message}`)
      .join('\n');
    throw new Error(
      `Cannot run find-strings — missing required options:\n${lines}`,
    );
  }

  const { resolved } = resolution;

  // Format/extension consistency is validated early, before any network work —
  // a silent mismatch would otherwise waste a full scan.
  assertFormatPathConsistency(resolved.output, resolved.format);

  // Enable the central logger for the whole process: debug/API/recovery logs
  // are only printed when `--enable-logs` was resolved, OR when running
  // interactively (interactive mode needs the full log to drive the picker).
  // Must run before any API calls below so the debug lines they emit are
  // visible/hidden correctly.
  configureLogger({ enabled: resolved.enableLogs || resolved.interactive });

  // Propagate the resolved GitLab URL to the module-level axiosInstance so
  // HTTP requests go to the right host. Necessary when only `config.gitlab.url`
  // (not `GITLAB_URL` env) is set, since `axiosInstance` was created at module
  // load before resolution ran. When env already provides the URL,
  // `axiosInstance.defaults.baseURL` matches `resolved.gitlabUrl` and this
  // assignment is a no-op.
  axiosInstance.defaults.baseURL = resolved.gitlabUrl;

  // Resolve the repository set (already filtered by excludeRepos — this must
  // mirror findStrings' filter so the picker / printed list matches what will
  // actually be searched). This list is ALSO handed to `findStrings` via
  // `projects` so it does not re-fetch the project list (avoiding a duplicate
  // API call and a duplicated "Найдено репозиториев" debug line). Kept pure:
  // findStrings still does its own exclude/selected filtering on top.
  //
  // Fetching the repo list can take a while — `getAllProjects` walks every
  // page of the GitLab projects API before any per-repo work begins, and
  // previously nothing was drawn during that phase, so the console looked
  // frozen. Show an indeterminate loader here so it's clear a request is in
  // flight; it is torn down as soon as the list is available (before the
  // interactive picker / headless list print), at which point the per-repo
  // `Обработано N из M` spinner takes over.
  const fetchReposTimer = setInterval(() => {
    progress.spin('Получение списка репозиториев…');
  }, 150);

  let allProjects: SearchProjectsItem[];
  try {
    logger.info(`Получение списка репозиториев (repoNameFilter='${resolved.repoNameFilter ?? ''}')…`);
    allProjects = await getAllProjects(resolved.repoNameFilter);
    logger.info(`Список репозиториев получен: ${allProjects.length}`);
  } finally {
    clearInterval(fetchReposTimer);
    progress.clear();
  }
  const excludeList = resolved.excludeRepos;
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
  if (resolved.interactive) {
    selectedRepos = await repoSelect(repos);

    if (selectedRepos.length === 0) {
      report('Поиск отменён: не выбрано ни одного репозитория.');
      await flushLogs();
      process.exit(0);
    }
  } else {
    // Nothing to scan (headless) — stop early instead of starting a
    // meaningless 0-repo search and an empty summary. Exit 0: not an error,
    // the filter/exclusions simply matched nothing.
    if (repos.length === 0) {
      logger.info('Репозитории не найдены: фильтр/исключения не дали результатов.');
      await flushLogs();
      process.exit(0);
    }
    // Headless info output: show where the search will run (stderr, so stdout
    // report stays clean/pipeable).
    progress.static(''); // разделитель между фазой получения списка и поиском
    report(`Будет выполнен поиск по ${repos.length} репозиториям:`);
    for (const repo of repos) {
      report(repo.name);
    }
  }

  // Per-repo error map, fed by onProgress's new `error` argument. Each repo is
  // keyed by name so we can correlate the error with the matching report entry
  // and the search results returned by findStrings (which omits errored repos).
  const repoErrors = new Map<string, string>();

  // Most recently *started* repo, fed by the `onRepoStart` hook. Analysis is
  // parallel (`concurrency`, default 5), so several repos start/finish out of
  // order; the live line shows the last one that began (not the last one that
  // finished) so it reflects what is underway right now.
  let lastStartedRepo: string | undefined;

  // Shared counters so `onRepoStart` / the spinner (which fire before/without a
  // given repo incrementing `done`) can render `Обработано N из M` using the
  // latest values reported by `onProgress` (whose `done`/`total` live inside its
  // closure). Initialised to the repo count this run processes — mirrors
  // findStrings' `total`, computed from the resolved/selected repo set.
  const doneRef = { current: 0 };
  const scannedCount = selectedRepos?.length ?? repos.length;
  const totalRef = { current: scannedCount };

  // Single source of truth for the live frame, shared by the callbacks and the
  // spinner timer so they always draw a consistent line.
  const currentFrame = (): string =>
    renderProgressFrame(doneRef.current, totalRef.current, lastStartedRepo);

  // Animate the loader: while work is running, periodically redraw the current
  // frame with the *same* label so `ProgressRenderer.spin` advances the glyph.
  const spinnerTimer = setInterval(() => {
    progress.spin(currentFrame());
  }, 150);

  const findOpts: FindStringsOptions = {
    searchStrings: strings,
    branch: resolved.branch,
    repoNameFilter: resolved.repoNameFilter,
    excludeRepos: resolved.excludeRepos,
    selectedRepos,
    projects: filtered,
    pathFilter: resolved.pathFilter,
    includeTests: resolved.includeTests,
    concurrency: resolved.concurrency,
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
        // Last repo done — stop the spinner and pin the final frame as a
        // permanent line so the log ends with a clean `Обработано M из M ...`
        // before the summary.
        clearInterval(spinnerTimer);
        progress.finish(currentFrame());
      } else {
        progress.spin(currentFrame());
      }
    },
  };

  let results: MatchResult[];
  try {
    logger.info(`Начинаю поиск по ${scannedCount} репозиториям… (concurrency=${resolved.concurrency})`);
    results = await findStrings(findOpts);
    logger.success('Поиск завершён.');
  } finally {
    // Always stop the spinner timer — both on the normal path (where
    // `onProgress` already finished/pinned the last frame via `progress.finish`)
    // and on an exceptional path (e.g. a thrown error mid-run). `progress.clear`
    // is a no-op when no live line is active, so it is safe to call here.
    clearInterval(spinnerTimer);
    progress.clear();
  }

  // The set of repos actually scanned = selectedRepos in interactive mode, or
  // the full filtered list headless. Every scanned repo gets a report entry.
  const scanned = selectedRepos ?? repos;
  const repoInfoByName = new Map<string, { id: number; webUrl: string | null }>();
  for (const p of filtered) {
    if (p.name && p.web_url !== null) {
      repoInfoByName.set(p.name, { id: p.id, webUrl: p.web_url ?? null });
    }
  }

  // Order matters for a stable, human-friendly report: entries that came back
  // in `results` first, then any scanned repo that had zero matches or an
  // error (so the report still shows it was searched).
  const repositories: ReportRepository[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (seen.has(r.projectName)) {
      continue;
    }
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
    if (seen.has(repo.name)) {
      continue;
    }
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

  const report2 = buildReport(resolved, strings, repositories);

  const payload =
    resolved.format === 'txt'
      ? renderReportTxt(report2)
      : JSON.stringify(report2, null, 2);

  // Resolve the target file: explicit --output, else auto name with
  // versioning. When --stdout is set we also emit to stdout.
  const outputPath = resolveOutputPath(resolved.output, resolved.format, formatDate());
  let wroteFile = false;

  if (outputPath) {
    // Ensure the parent directory exists, recursively. `--output ./a/b/c.json`
    // creates `./a`, `./a/b`, and `./a/b/c.json` in one shot — saves the user
    // from having to mkdir before every scan, and keeps batch scripts tidy.
    // `{ recursive: true }` is a no-op when the directory already exists, so
    // it's safe to call unconditionally. `dirname('foo.json')` returns '.',
    // and `mkdir('.', { recursive: true })` is also a no-op.
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, payload, 'utf-8');
    wroteFile = true;
  }

  // Итоговая сводка-блок (вместо одиночной строки «Wrote N repo(s) to …»).
  // Сводка печатается всегда; условна только строка `✓ Отчёт:` (путь есть лишь
  // когда файл реально записан, `outputPath` может быть `undefined`).
  const errored = repositories.filter((r) => r.error !== null);
  progress.static(''); // разделитель между поиском и сводкой
  progress.static(green(`✓ Отсканировано репозиториев: ${repositories.length}`));
  if (errored.length > 0) {
    progress.static(yellow(`⚠ Из них с ошибкой: ${errored.length} (${errored.map((r) => r.projectName).join(', ')})`));
  }
  if (outputPath) {
    progress.static(green(`✓ Отчёт: ${outputPath}`));
  }

  if (resolved.stdout) {
    process.stdout.write(`${payload}\n`);
  }

  return { report: report2, outputPath: wroteFile ? outputPath : undefined };
}
