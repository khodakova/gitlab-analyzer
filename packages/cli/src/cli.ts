// Note: `#!/usr/bin/env node` shebang is injected by tsup's `banner` option
// in `tsup.config.ts`. Keeping it out of source keeps the file lintable as
// a normal ES module (no execute-permission assumptions).
import { Command, Option, CommanderError } from 'commander';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findStrings,
  loadConfig,
  configureLogger,
  logger,
  type FindStringsOptions,
  type MatchResult,
  type RepoInfo,
} from '@gitlab-analyzer/core';
import {
  axiosInstance,
  getAllProjects,
  ProgressRenderer,
  type GitlabAnalyzerConfig,
  type SearchProjectsItem,
} from '@gitlab-analyzer/core/internal';
import { repoSelect } from './utils/repo-select.ts';

/**
 * Single shared renderer for all CLI status output that goes to stderr and is
 * NOT gated by `--enable-logs`: progress (in-place dynamic line), summaries,
 * and the pre-search repo list. These are user-facing status lines that stay
 * visible regardless of verbosity. Debug/API/recovery output lives in the
 * central logger (`src/utils/logger.ts`) and is gated separately.
 *
 * The renderer is the single point of write for these lines: any static line
 * it prints clears the active in-place progress line first, so a live frame
 * never interleaves with ordinary output.
 */
const progress = new ProgressRenderer();

/**
 * Print a static (non-overwritten) status line to stderr. Routes through the
 * {@link progress} renderer so any active dynamic progress line is cleared
 * before this line is written.
 */
function report(line: string): void {
  progress.static(line);
}

/**
 * Compose the live progress frame shown on the single dynamic stderr line.
 *
 * The frame is `Обработано N из M` (N = repos finished, M = total), and when a
 * repo has been started it is followed by ` · <name>` of the most recently
 * *started* repo — the `onRepoStart` hook reveals which repo is being worked on
 * right now, whereas `onProgress` only fires on completion.
 *
 * @param done - Repos processed so far (1-based, from `onProgress`).
 * @param total - Total repos to process.
 * @param lastStarted - The repo most recently started (from `onRepoStart`);
 *   omitted while nothing has been started yet.
 */
function renderProgressFrame(
  done: number,
  total: number,
  lastStarted?: string,
): string {
  const prefix = `Обработано ${done} из ${total}`;
  return lastStarted !== undefined ? `${prefix} · ${lastStarted}` : prefix;
}

/**
 * CLI + programmatic entry for `gitlab-analyzer`.
 *
 * The CLI exposes one subcommand today (`find-strings`); additional commands
 * will register here as they ship in later phases.
 *
 * **Exit codes** (matches conventional Unix semantics):
 *
 * | Code | Meaning                                                          |
 * |------|------------------------------------------------------------------|
 * | 0    | Success — output written (file or stdout).                        |
 * | 1    | Runtime error — failed to load config, GitLab API failure, I/O.  |
 * | 2    | Invalid CLI usage — commander-detected (unknown flag, missing arg). |
 *
 * **Stdout vs stderr:** the report (json or txt) is written to the file at
 * `--output <path>` (or an auto-generated `find-strings-results-<DATE>.<ext>`
 * name when none is given), and additionally to stdout when `--stdout` is
 * passed. Progress (`[done/total] repo-name`), errors and summary lines are
 * always written to stderr so the report stays clean/pipeable.
 *
 * **Runtime invocation:** the file shipped as `bin/gitlab-analyzer.js`
 * dynamically imports `./dist/cli.js` and calls the exported
 * {@link runCli} function. There are no top-level side-effects, which
 * keeps this module safe to import from tests.
 */

/**
 * CLI options for the `find-strings` subcommand. Produced by commander and
 * passed into {@link runFindStrings}.
 *
 * All fields are optional at the type level because commander only assigns
 * them when the corresponding flag is present. {@link resolveOptions}
 * fills in config-file and built-in defaults before building the
 * {@link FindStringsOptions} handed to the library.
 *
 * Resolution precedence (highest wins):
 *
 *   1. CLI flag (this object)
 *   2. Environment variable (`PRIVATE_TOKEN`, `GITLAB_URL` — the latter
 *      typically populated by `.env` via dotenv)
 *   3. `gitlab-analyzer.json` config file (`defaults.*`,
 *      `commands.find-strings.*`, `gitlab.url`)
 *   4. Built-in default (`'develop'` for branch, `/src/` for path filter,
 *      `false` for includeTests, `5` for concurrency, etc.)
 */
export type FindStringsCliOptions = {
  repoFilter?: string;
  exclude?: string[];
  branch?: string;
  pathFilter?: string;
  includeTests?: boolean;
  output?: string;
  concurrency?: number;
  interactive?: boolean;
  enableLogs?: boolean;
  format?: 'txt' | 'json';
  stdout?: boolean;
};

/**
 * Fully resolved `find-strings` options — every required field is present
 * (or the `errors` array is non-empty in {@link resolveOptions}'s return).
 */
export type ResolvedFindStringsOptions = {
  /** Base URL of the GitLab instance (from `GITLAB_URL` env or `gitlab.url` config). */
  gitlabUrl: string;
  /** Branch to scan. */
  branch: string;
  /** Substring filter for project names (optional). */
  repoNameFilter: string | undefined;
  /** Project names to skip. */
  excludeRepos: string[];
  /** Substring filter for file paths inside each archive. */
  pathFilter: string;
  /** Whether to include `*.test.*` files. */
  includeTests: boolean;
  /** Max parallel archive-fetch + zip-parse tasks. */
  concurrency: number;
  /** Output file path; `undefined` → auto-generated name. */
  output: string | undefined;
  /** Whether to prompt the user to pick repos before searching. */
  interactive: boolean;
  /** Whether debug/API logging is enabled (CLI > ENABLE_LOGS > defaults.enableLogs). */
  enableLogs: boolean;
  /** Report format: `json` (default) or `txt`. */
  format: 'txt' | 'json';
  /** When true, also write the report to stdout (in addition to the file). */
  stdout: boolean;
};

/**
 * Description of a single missing-required option. Collected into a list
 * so the user gets ALL missing fields in one error instead of fixing them
 * one by one across multiple invocations.
 */
export type ResolveError = {
  field: string;
  message: string;
};

export type ResolveResult =
  | { ok: true; resolved: ResolvedFindStringsOptions }
  | { ok: false; errors: ResolveError[] };

/**
 * Resolve every `find-strings` option using the documented precedence
 * (CLI → env → config → built-in default) and collect ALL missing-required
 * fields into a single structured error list.
 *
 * Required (must be present from at least one source):
 *
 *   - `gitlabUrl`  — from `GITLAB_URL` env (via dotenv-loaded `.env`) or
 *                    `gitlab.url` in `gitlab-analyzer.json`
 *   - `PRIVATE_TOKEN` — from env only; intentionally NEVER read from config
 *                       (security policy — see README "Security: tokens")
 *   - At least one positional search string
 *
 * Each error carries a `field` name (for programmatic handling) and a
 * `message` explaining how to satisfy it. The CLI layer formats these into
 * the user-facing error.
 *
 * Exported for unit testing; not part of the public library surface
 * (re-exported from `src/index.ts` only the high-level helpers).
 */
export function resolveOptions(
  strings: readonly string[],
  cliOpts: FindStringsCliOptions,
  config: GitlabAnalyzerConfig,
): ResolveResult {
  const errors: ResolveError[] = [];

  // Required: gitlabUrl — env first, then config.
  const gitlabUrl = process.env.GITLAB_URL ?? config.gitlab?.url;
  if (!gitlabUrl) {
    errors.push({
      field: 'gitlabUrl',
      message:
        'Set GITLAB_URL in the environment (or .env), or add "gitlab.url" to gitlab-analyzer.json.',
    });
  }

  // Required: PRIVATE_TOKEN — env only (security: never read tokens from config).
  if (!process.env.PRIVATE_TOKEN) {
    errors.push({
      field: 'PRIVATE_TOKEN',
      message:
        'Set PRIVATE_TOKEN in the environment (or .env). Tokens are never read from config files.',
    });
  }

  // Required: at least one search string.
  if (strings.length === 0) {
    errors.push({
      field: 'strings',
      message: 'Provide at least one search string as a positional argument.',
    });
  }

  // Optional/derived with fallback chain: CLI > env > config > built-in default.
  const cmdDefaults = config.commands?.['find-strings'];

  // `enableLogs` — CLI flag > ENABLE_LOGS env > config.defaults.enableLogs >
  // built-in default (false). ENABLE_LOGS accepts '1', 'true', 'yes', 'on' as
  // truthy (case-insensitive). An unset/empty ENABLE_LOGS contributes nothing
  // (falls through to config), while any explicitly-set value (true or false)
  // is authoritative over config.
  let envEnableLogs: boolean | undefined;
  const rawEnvEnableLogs = process.env.ENABLE_LOGS;
  if (rawEnvEnableLogs !== undefined && rawEnvEnableLogs !== '') {
    envEnableLogs = /^(1|true|yes|on)$/i.test(rawEnvEnableLogs);
  }
  const enableLogs =
    cliOpts.enableLogs ??
    envEnableLogs ??
    config.defaults?.enableLogs ??
    false;

  const resolved: ResolvedFindStringsOptions = {
    gitlabUrl: gitlabUrl as string, // safe: gated above; errors[] is non-empty if missing
    branch: cliOpts.branch ?? config.defaults?.branch ?? 'develop',
    repoNameFilter:
      cliOpts.repoFilter ?? config.defaults?.repoNameFilter,
    excludeRepos:
      cliOpts.exclude ?? config.defaults?.excludeRepos ?? [],
    pathFilter: cliOpts.pathFilter ?? config.defaults?.pathFilter ?? '/src/',
    includeTests:
      cliOpts.includeTests ?? config.defaults?.includeTests ?? false,
    concurrency:
      cliOpts.concurrency ?? cmdDefaults?.concurrency ?? 5,
    output: cliOpts.output ?? cmdDefaults?.output,
    interactive: cliOpts.interactive ?? false,
    enableLogs,
    format: cliOpts.format ?? 'json',
    stdout: cliOpts.stdout ?? false,
  };

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, resolved };
}

/**
 * Internal: shared implementation invoked by the commander action handler.
 *
 * Exported separately so tests can drive the full pipeline (resolve options →
 * run search → write output) without spawning a child process.
 *
 * @returns Object containing the parsed results and the resolved output path
 *   (or `undefined` if results were written to stdout).
 * @throws {Error} When one or more required options cannot be resolved from
 *   any source. The message contains the full list of missing fields with
 *   guidance on how to satisfy each one.
 */
/**
 * Normalized report format, either the JSON object shape (default) or the
 * human-readable text render.
 */
export type ReportFormat = 'txt' | 'json';

/**
 * A single repository entry inside the report's `repositories` array.
 * Combines the per-repo identity/metadata with the search results and any
 * error that occurred while fetching that repo's archive.
 */
export type ReportRepository = {
  projectId: number;
  projectName: string;
  projectDescription: string | null;
  webUrl: string | null;
  branchExists: boolean;
  error: string | null;
  resultsLength: number;
  results: MatchResult['results'];
};

/**
 * Full report written to file/stdout. Replaces the old bare-array output so
 * the report self-describes the run (when, which branch, which repos, which
 * strings, filters) alongside the per-repo results.
 */
export type Report = {
  metadata: {
    generatedAt: string;
    branch: string;
    searchStrings: string[];
    repoNameFilter: string | null;
    pathFilter: string;
    includeTests: boolean;
    excludeRepos: string[];
  };
  repositories: ReportRepository[];
};

/**
 * True when the error likely means "the requested branch does not exist" on
 * that repo (GitLab returns HTTP 404 / "not found" for a missing sha).
 * Used to drive `branchExists` in the report. This is a heuristic — a repo
 * that is private/archived/removed can also yield 404.
 */
function isBranchMissingError(message: string): boolean {
  return /\b404\b/i.test(message) || /not found/i.test(message);
}

/**
 * True when `path` ends with the given extension (case-insensitive).
 */
function hasExtension(path: string, ext: string): boolean {
  return extname(path).toLowerCase() === ext.toLowerCase();
}

/**
 * Resolve the output path for the report.
 *
 * - If `--output` is provided, it is used verbatim (after a format/vs-extension
 *   conflict check) and overrides any auto-generated name.
 * - Otherwise an auto name `find-strings-results-<DATE>.<ext>` is generated in
 *   the current directory; if a file with that name already exists a numeric
 *   suffix is appended before the extension (`-1`, `-2`, …) until a free name
 *   is found.
 *
 * @param output - Explicit `--output` path, or `undefined` for auto-naming.
 * @param format - Report format, drives the extension of the auto name.
 * @param date - Timestamp label embedded in the auto name.
 * @returns The concrete path to write to.
 */
export function resolveOutputPath(
  output: string | undefined,
  format: ReportFormat,
  date: string,
): string {
  if (output) {
    return output;
  }
  const ext = format === 'txt' ? '.txt' : '.json';
  const base = `find-strings-results-${date}${ext}`;
  if (!existsSync(base)) {
    return base;
  }
  // Version existing auto-named files: -1, -2, ... up to a free name.
  const stem = `find-strings-results-${date}`;
  let version = 1;
  let candidate = `${stem}-${version}${ext}`;
  while (existsSync(candidate)) {
    version++;
    candidate = `${stem}-${version}${ext}`;
  }
  return candidate;
}

/**
 * Throw when `--format` conflicts with the extension of an explicit `--output`
 * path (e.g. `--format txt -o result.json`). The user is expected to align
 * format and extension; silently picking one would be surprising.
 *
 * @throws {Error} On a mismatch between format and the output path extension.
 */
export function assertFormatPathConsistency(
  output: string | undefined,
  format: ReportFormat,
): void {
  if (!output) {
    return;
  }
  const ext = extname(output);
  if (ext === '') {
    // No extension — nothing to conflict with.
    return;
  }
  const expected = format === 'txt' ? '.txt' : '.json';
  if (!hasExtension(output, expected)) {
    throw new Error(
      `--format ${format} conflicts with output path "${output}" (expected ${expected} extension).`,
    );
  }
}

/**
 * Render the report as human-readable text. Mirrors the JSON structure
 * (metadata first, then per-repo results with full file content).
 */
export function renderReportTxt(report: Report): string {
  const lines: string[] = [];
  const { metadata, repositories } = report;

  lines.push('GitLab strings report');
  lines.push('====================');
  lines.push(`Generated at: ${metadata.generatedAt}`);
  lines.push(`Branch: ${metadata.branch}`);
  lines.push(`Search strings: ${metadata.searchStrings.join(', ') || '(none)'}`);
  lines.push(`Repo name filter: ${metadata.repoNameFilter ?? '(none)'}`);
  lines.push(`Path filter: ${metadata.pathFilter}`);
  lines.push(`Include tests: ${metadata.includeTests ? 'yes' : 'no'}`);
  lines.push(
    `Excluded repos: ${metadata.excludeRepos.length > 0 ? metadata.excludeRepos.join(', ') : '(none)'}`,
  );
  lines.push(
    `Repositories scanned: ${repositories.length}`,
  );
  lines.push('');

  for (const repo of repositories) {
    lines.push(`---- ${repo.projectName} (id: ${repo.projectId}) ----`);
    if (repo.projectDescription) {
      lines.push(`Description: ${repo.projectDescription}`);
    }
    if (repo.webUrl) {
      lines.push(`URL: ${repo.webUrl}`);
    }
    lines.push(`Branch exists: ${repo.branchExists ? 'yes' : 'no'}`);
    if (repo.error) {
      lines.push(`Error: ${repo.error}`);
    }
    lines.push(`Matches: ${repo.resultsLength} file(s)`);

    for (const file of repo.results) {
      lines.push('');
      lines.push(`  > ${file.filename}`);
      lines.push(`    matched: ${file.matches.join(', ')}`);
      if (file.content.length > 0) {
        for (const line of file.content) {
          lines.push(`    ${line}`);
        }
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build the report object from the resolved options, the scanned repo list,
 * the search results, and the per-repo error map gathered via `onProgress`.
 *
 * `repositories` lists EVERY repo that was actually scanned (selected in
 * interactive mode, or the full filtered set headless), including those with
 * zero matches and those that errored — so the report is a faithful audit of
 * what was searched.
 */
export function buildReport(
  resolvedOptions: Pick<
    ResolvedFindStringsOptions,
    'branch' | 'repoNameFilter' | 'pathFilter' | 'includeTests' | 'excludeRepos' | 'format' | 'stdout'
  >,
  strings: string[],
  scannedRepos: ReportRepository[],
): Report {
  // scannedRepos is already the final, per-repo list the caller assembled.
  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      branch: resolvedOptions.branch,
      searchStrings: strings,
      repoNameFilter: resolvedOptions.repoNameFilter ?? null,
      pathFilter: resolvedOptions.pathFilter,
      includeTests: resolvedOptions.includeTests,
      excludeRepos: resolvedOptions.excludeRepos,
    },
    repositories: scannedRepos,
  };
}

/**
 * Internal: shared implementation invoked by the commander action handler.
 *
 * Exported separately so tests can drive the full pipeline (resolve options →
 * run search → build report → write output) without spawning a child process.
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
    allProjects = await getAllProjects(resolved.repoNameFilter);
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
      process.exit(0);
    }
  } else {
    // Headless info output: show where the search will run (stderr, so stdout
    // report stays clean/pipeable).
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
  const totalRef = { current: selectedRepos?.length ?? repos.length };

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
    results = await findStrings(findOpts);
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
  const resultByRepo = new Map<string, MatchResult>();
  for (const r of results) {
    resultByRepo.set(r.projectName, r);
  }
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
    report(
      `Wrote ${repositories.length} repo(s) to ${outputPath}`,
    );
  }

  if (resolved.stdout) {
    process.stdout.write(`${payload}\n`);
  }

  return { report: report2, outputPath: wroteFile ? outputPath : undefined };
}

/**
 * Local date-time label used in auto-generated report filenames, e.g.
 * `2026-08-13-1536`. Format is not contractual — it only needs to be unique
 * enough per run and readable as a timestamp.
 */
function formatDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  );
}

/**
 * Build the top-level commander {@link Command}. Exported so tests can call
 * `.exitOverride().parseAsync(argv)` and capture errors / output without
 * touching real `process.exit` or `process.stderr`.
 *
 * Note: `exitOverride()` is called BEFORE adding the `find-strings`
 * subcommand so that the subcommand inherits the override callback via
 * `copyInheritedSettings`. If you call `program.exitOverride()` *after*
 * `buildProgram()` returns, the subcommand will still call `process.exit`
 * directly on parse errors — commander copies inherited settings only at
 * subcommand creation time.
 */
export function buildProgram(): Command {
  const program = new Command();

  // Critical: exitOverride() must run BEFORE `.command()` so that the
  // resulting subcommand inherits the override callback.
  program.exitOverride();

  program
    .name('gitlab-analyzer')
    .description(
      'CLI + library for mass analysis of GitLab repositories (search strings across projects)',
    )
    .version('0.1.0');

  program
    .command('find-strings')
    .description(
      'Search for specific strings across all GitLab projects reachable from the configured instance',
    )
    .argument(
      '<strings...>',
      'One or more search substrings; a file matches if it contains ANY of them',
    )
    .addOption(
      new Option('-r, --repo-filter <str>', 'Substring filter for project names (passed to GitLab search=)'),
    )
    .option(
      '-e, --exclude <list>',
      'Comma-separated list of repo names to skip',
      (val: string) =>
        val
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
    )
    .option('-b, --branch <name>', 'Branch to scan in every project')
    .option('-p, --path-filter <str>', 'Substring filter for file paths inside the archive')
    .option('--include-tests', 'Include *.test.* files in the search')
    .option(
      '--interactive',
      'Let you choose which repositories to search (space toggles a repo, Enter confirms); empty selection cancels',
    )
    .option(
      '--enable-logs',
      'Enable debug/API logging (also enabled automatically with --interactive)',
    )
    .addOption(
      new Option(
        '--format <txt|json>',
        'Report format. Default: json (also drives the extension of the auto-generated file name).',
      ).choices(['txt', 'json']),
    )
    .option(
      '--stdout',
      'Also write the report to stdout (in addition to the file)',
    )
    .option('-o, --output <path>', 'Path to write the report; omit to use an auto-generated file name')
    .option(
      '-c, --concurrency <n>',
      'Maximum number of parallel archive-fetch + zip-parse tasks',
      (val: string) => parseInt(val, 10),
    )
    .action(async (strings: string[], opts: FindStringsCliOptions) => {
      try {
        await runFindStrings(strings, opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  return program;
}

/**
 * Runtime entry point. Called from `bin/gitlab-analyzer.js` after a dynamic
 * import of the built `dist/cli.js`.
 *
 * Parses `argv`, runs the matching subcommand, and either returns
 * normally (success / `--help` / `--version`) or terminates the process
 * with:
 *
 * - `2` on commander-reported CLI usage errors (unknown flag, missing
 *   argument). Commander has already printed the diagnostic to stderr.
 * - `1` on any other thrown error. The error message is written to stderr
 *   with a `Fatal:` prefix.
 *
 * Internally this enables commander's `exitOverride()` so the function can
 * catch and translate usage errors instead of commander calling
 * `process.exit` directly. Tests should drive {@link buildProgram} (or
 * {@link runFindStrings}) directly when they want full control over
 * commander's error machinery.
 *
 * @param argv - Optional override for `process.argv`. Defaults to the
 *   real argv when omitted.
 */
export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  try {
    // `buildProgram()` already calls exitOverride() so subcommands inherit
    // the override callback — do NOT call program.exitOverride() again
    // here, otherwise parse errors thrown by the subcommand would still
    // hit process.exit directly.
    await buildProgram().parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help and version are successful no-ops; commander has already
      // written the output to stdout.
      if (
        err.code === 'commander.helpDisplayed' ||
        err.code === 'commander.help' ||
        err.code === 'commander.version'
      ) {
        return;
      }
      // Any other commander-prefixed code is a CLI usage error.
      process.exit(2);
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Fatal: ${message}`);
    process.exit(1);
  }
}

/**
 * Entry-point guard: invoke {@link runCli} only when this module is the
 * program's entry script (`node dist/cli.js ...`).
 *
 * Without this guard, `node dist/cli.js --help` loads the module (which
 * triggers transitive side-effects — e.g. `dotenv.config()` in
 * `src/api/config.ts`) and then exits without ever calling {@link runCli},
 * so commander never sees the argv and nothing happens.
 *
 * When the module is *imported* instead of executed (Vitest tests, downstream
 * consumers pulling in `runCli` / `buildProgram` / `runFindStrings`), the
 * guard is false and no CLI startup happens — so the public surface stays
 * side-effect-free for library use, matching the original "no top-level
 * side-effects" design note at the top of this file.
 *
 * Comparison uses `fileURLToPath(import.meta.url)` against `process.argv[1]`
 * — the canonical "am I the entry script?" check for ESM Node programs.
 */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli();
}
