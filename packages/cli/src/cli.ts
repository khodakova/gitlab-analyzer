// Note: `#!/usr/bin/env node` shebang is injected by tsup's `banner` option
// in `tsup.config.ts`. Keeping it out of source keeps the file lintable as
// a normal ES module (no execute-permission assumptions).
import { Command, Option, CommanderError } from 'commander';
import { fileURLToPath } from 'node:url';
import { logger, flushLogs } from '@gitlab-analyzer/core';
import { runFindMatches } from './commands/find-matches.ts';
import { runListRepos } from './commands/list-repos.ts';
import type { FindMatchesCliOptions } from './utils/options.ts';

// The thin CLI layer only wires commander to the command implementations.
// All option resolution, repo fetching, search orchestration, report
// building/rendering and output writing live in focused utility modules
// (see `src/utils/` and `src/commands/`).

// Shared comma-list parser for `--exclude` (identical semantics in every
// subcommand that takes it): trim items, drop empties.
const parseCommaList = (val: string): string[] =>
  val
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/**
 * Shared error handler for subcommand actions: log the message and terminate
 * with exit code 1 (runtime error, as opposed to commander's usage errors
 * handled in {@link runCli}).
 */
async function handleActionError(err: unknown): Promise<never> {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(`Error: ${message}`);
  await flushLogs();
  process.exit(1);
}

/**
 * Build the top-level commander {@link Command}. Exported so tests can call
 * `.exitOverride().parseAsync(argv)` and capture errors / output without
 * touching real `process.exit` or `process.stderr`.
 *
 * Note: `exitOverride()` is called BEFORE adding the `find-matches`
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
    .version('0.1.0')
    .option(
      '--private-token <value>',
      'GitLab personal access token. Overrides PRIVATE_TOKEN env. SECURITY: passing a token on the command line exposes it in shell history / process list / CI logs — prefer PRIVATE_TOKEN env (or .env) when possible.',
    )
    .option(
      '--gitlab-url <value>',
      'Base URL of the GitLab instance. Overrides GITLAB_URL env and gitlab.url config.',
    );

  program
    .command('find-matches')
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
      parseCommaList,
    )
    .option('-b, --branch <name>', 'Branch to scan in every project')
    .option(
      '--file-include <list>',
      [
        'Comma-separated glob patterns for file paths to scan (empty = scan all).',
        "Paths from the archive keep a leading '/', so `*.ts` does NOT match `/src/foo.ts` — use `**/*.ts` (anywhere) or `**/src/**/*.ts` / `/src/**/*.ts` (only under `/src/`); `src/**/*.ts` does NOT work because the path starts with `/`.",
      ].join(' '),
      (val: string) =>
        val
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
    )
    .option(
      '--file-exclude <list>',
      'Comma-separated glob patterns for file paths to skip (gitignore-style, wins over --file-include; same `*.ts` vs `**/*.ts` rule as --file-include)',
      (val: string) =>
        val
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
    )
    .option(
      '--interactive',
      'Let you choose which repositories to search (all pre-selected; ↑/↓ scrolls, space toggles, Enter confirms); empty selection cancels',
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
    .addOption(
      new Option(
        '--output-filter <found|not-found|all>',
        'Which repositories to include in the report file: found = only repos with matches; not-found = only repos without matches; all = everything (default).',
      ).choices(['found', 'not-found', 'all']),
    )
    .option(
      '--stdout',
      'Also write the report to stdout (in addition to the file)',
    )
    .option('-o, --output <path>', 'Path to write the report; omit to use an auto-generated file name')
    .option(
      '--metrics-file <path>',
      'Write performance metrics (NDJSON: run/repo/summary) to this file. Diagnostic only — does not affect the report.',
    )
    .option(
      '-c, --concurrency <n>',
      'Maximum number of parallel archive-fetch + zip-parse tasks',
      (val: string) => parseInt(val, 10),
    )
    .action(async (strings: string[], opts: FindMatchesCliOptions) => {
      try {
        const global = program.opts<{ privateToken?: string; gitlabUrl?: string }>();
        const merged: FindMatchesCliOptions = {
          ...opts,
          privateToken: global.privateToken,
          gitlabUrl: global.gitlabUrl,
        };
        await runFindMatches(strings, merged);
      } catch (err) {
        await handleActionError(err);
      }
    });

  program
    .command('list-repos')
    .description(
      'Print the repositories that find-matches would scan with the same filters (repo name filter + exclusions), without running any search',
    )
    .addOption(
      new Option('-r, --repo-filter <str>', 'Substring filter for project names (passed to GitLab search=)'),
    )
    .option(
      '-e, --exclude <list>',
      'Comma-separated list of repo names to skip',
      parseCommaList,
    )
    .action(async (opts: FindMatchesCliOptions) => {
      try {
        const global = program.opts<{ privateToken?: string; gitlabUrl?: string }>();
        const merged: FindMatchesCliOptions = {
          ...opts,
          privateToken: global.privateToken,
          gitlabUrl: global.gitlabUrl,
        };
        await runListRepos(merged);
      } catch (err) {
        await handleActionError(err);
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
 * `runFindMatches`) directly when they want full control over commander's
 * error machinery.
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
      await flushLogs();
      process.exit(2);
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Fatal: ${message}`);
    await flushLogs();
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
 * consumers pulling in `runCli` / `buildProgram` / `runFindMatches`), the
 * guard is false and no CLI startup happens — so the public surface stays
 * side-effect-free for library use.
 *
 * Comparison uses `fileURLToPath(import.meta.url)` against `process.argv[1]`
 * — the canonical "am I the entry script?" check for ESM Node programs.
 */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli();
}
