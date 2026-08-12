// Note: `#!/usr/bin/env node` shebang is injected by tsup's `banner` option
// in `tsup.config.ts`. Keeping it out of source keeps the file lintable as
// a normal ES module (no execute-permission assumptions).
import { Command, Option, CommanderError } from 'commander';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findStrings,
  type FindStringsOptions,
  type MatchResult,
} from './commands/find-strings.ts';
import { loadConfig } from './config/load.ts';
import type { GitlabAnalyzerConfig } from './config/schema.ts';
import { axiosInstance } from './api/config.ts';
import { getAllProjects } from './utils/get-projects.ts';
import { repoSelect } from './utils/repo-select.ts';
import type { RepoInfo } from './types.ts';

/**
 * Thin output helper for CLI-level lines that must always go to stderr
 * (progress, summaries, errors, the pre-search repo list). Kept behind one
 * function so a future `--enable-logs` flag can add verbosity levels without
 * touching every call site.
 */
function report(line: string): void {
  process.stderr.write(`${line}\n`);
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
 * **Stdout vs stderr:** the JSON result of `find-strings` is written to
 * `--output <path>` when provided (or the path from
 * `commands.find-strings.output` in the config file), and to stdout
 * otherwise. Progress (`[done/total] repo-name`) and error / summary lines
 * are always written to stderr so the JSON stays pipeable.
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
  /** Output file path; `undefined` → stdout. */
  output: string | undefined;
  /** Whether to prompt the user to pick repos before searching. */
  interactive: boolean;
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

  // Optional/derived with fallback chain: CLI > config > built-in default.
  const cmdDefaults = config.commands?.['find-strings'];

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
export async function runFindStrings(
  strings: string[],
  opts: FindStringsCliOptions,
): Promise<{ results: MatchResult[]; outputPath: string | undefined }> {
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

  // Propagate the resolved GitLab URL to the module-level axiosInstance so
  // HTTP requests go to the right host. Necessary when only `config.gitlab.url`
  // (not `GITLAB_URL` env) is set, since `axiosInstance` was created at module
  // load before resolution ran. When env already provides the URL,
  // `axiosInstance.defaults.baseURL` matches `resolved.gitlabUrl` and this
  // assignment is a no-op.
  axiosInstance.defaults.baseURL = resolved.gitlabUrl;

  // Resolve the repository set (already filtered by excludeRepos — this must
  // mirror findStrings' filter so the picker / printed list matches what will
  // actually be searched). Used for the interactive picker and the headless
  // "will search these repos" report. One extra projects-list fetch is a
  // deliberate trade-off to keep `findStrings` pure (no console/process calls).
  const allProjects = await getAllProjects(resolved.repoNameFilter);
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
    // JSON stays pipeable).
    report(`Будет выполнен поиск по ${repos.length} репозиториям:`);
    for (const repo of repos) {
      report(repo.name);
    }
  }

  const findOpts: FindStringsOptions = {
    searchStrings: strings,
    branch: resolved.branch,
    repoNameFilter: resolved.repoNameFilter,
    excludeRepos: resolved.excludeRepos,
    selectedRepos,
    pathFilter: resolved.pathFilter,
    includeTests: resolved.includeTests,
    concurrency: resolved.concurrency,
    onProgress: (done, total, currentRepo) => {
      report(`[${done}/${total}] ${currentRepo}`);
    },
  };

  const results: MatchResult[] = await findStrings(findOpts);

  const json = JSON.stringify(results, null, 2);
  const outputPath = resolved.output;

  if (outputPath) {
    // Ensure the parent directory exists, recursively. `--output ./a/b/c.json`
    // creates `./a`, `./a/b`, and `./a/b/c.json` in one shot — saves the user
    // from having to mkdir before every scan, and keeps batch scripts tidy.
    // `{ recursive: true }` is a no-op when the directory already exists, so
    // it's safe to call unconditionally. `dirname('foo.json')` returns '.',
    // and `mkdir('.', { recursive: true })` is also a no-op.
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, json, 'utf-8');
    report(`Wrote ${results.length} result(s) to ${outputPath}`);
  } else {
    process.stdout.write(`${json}\n`);
  }

  return { results, outputPath };
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
    .option('-o, --output <path>', 'Path to write JSON results; omit to write to stdout')
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
        process.stderr.write(`Error: ${message}\n`);
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
    process.stderr.write(`Fatal: ${message}\n`);
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
