// Note: `#!/usr/bin/env node` shebang is injected by tsup's `banner` option
// in `tsup.config.ts`. Keeping it out of source keeps the file lintable as
// a normal ES module (no execute-permission assumptions).
import { Command, Option, CommanderError } from 'commander';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  findStrings,
  type FindStringsOptions,
  type MatchResult,
} from './commands/find-strings.ts';
import { loadConfig } from './config/load.ts';

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
 * them when the corresponding flag is present. The action handler fills in
 * config-file fallbacks before building the {@link FindStringsOptions} it
 * hands to the library.
 */
export type FindStringsCliOptions = {
  repoFilter?: string;
  exclude?: string[];
  branch?: string;
  pathFilter?: string;
  includeTests?: boolean;
  output?: string;
  concurrency?: number;
};

/**
 * Internal: shared implementation invoked by the commander action handler.
 *
 * Exported separately so tests can drive the full pipeline (load config →
 * run search → write output) without spawning a child process.
 *
 * @returns Object containing the parsed results and the resolved output path
 *   (or `undefined` if results were written to stdout).
 */
export async function runFindStrings(
  strings: string[],
  opts: FindStringsCliOptions,
): Promise<{ results: MatchResult[]; outputPath: string | undefined }> {
  const config = await loadConfig();
  const cmdConfig = config.commands['find-strings'];

  const findOpts: FindStringsOptions = {
    searchStrings: strings,
    branch: opts.branch ?? config.defaults.branch,
    repoNameFilter: opts.repoFilter ?? config.defaults.repoNameFilter,
    excludeRepos: opts.exclude ?? config.defaults.excludeRepos,
    pathFilter: opts.pathFilter ?? config.defaults.pathFilter,
    includeTests: opts.includeTests ?? config.defaults.includeTests,
    concurrency: opts.concurrency ?? cmdConfig.concurrency,
    onProgress: (done, total, currentRepo) => {
      process.stderr.write(`[${done}/${total}] ${currentRepo}\n`);
    },
  };

  const results: MatchResult[] = await findStrings(findOpts);

  const json = JSON.stringify(results, null, 2);
  const outputPath = opts.output ?? cmdConfig.output;

  if (outputPath) {
    await writeFile(outputPath, json, 'utf-8');
    process.stderr.write(
      `Wrote ${results.length} result(s) to ${outputPath}\n`,
    );
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
