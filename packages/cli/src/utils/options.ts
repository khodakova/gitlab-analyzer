import type { GitlabAnalyzerConfig } from '@gitlab-analyzer/core/internal';

/**
 * CLI options for the `find-matches` subcommand. Produced by commander and
 * passed into `runFindMatches`.
 *
 * All fields are optional at the type level because commander only assigns
 * them when the corresponding flag is present. {@link resolveOptions}
 * fills in config-file and built-in defaults before building the
 * `ResolvedFindMatchesOptions` handed to the library.
 *
 * Resolution precedence (highest wins):
 *
 *   1. CLI flag (this object)
 *   2. Environment variable (`PRIVATE_TOKEN`, `GITLAB_URL` — the latter
 *      typically populated by `.env` via dotenv)
 *   3. `gitlab-analyzer.json` config file (`defaults.*`,
 *      `commands.find-matches.*`, `gitlab.url`)
 *   4. Built-in default (`'develop'` for branch, `[]` for fileInclude /
 *      fileExclude, `5` for concurrency, etc.)
 */
export type FindMatchesCliOptions = {
  repoFilter?: string;
  exclude?: string[];
  branch?: string;
  /** Glob patterns to SCAN (commander returns string[] from comma-split). */
  fileInclude?: string[];
  /** Glob patterns to SKIP (commander returns string[] from comma-split). */
  fileExclude?: string[];
  output?: string;
  concurrency?: number;
  interactive?: boolean;
  enableLogs?: boolean;
  format?: 'txt' | 'json';
  stdout?: boolean;
  /** Path to write performance metrics (NDJSON). Diagnostic; only via CLI flag. */
  metricsFile?: string;
};

/**
 * Fully resolved `find-matches` options — every required field is present
 * (or the `errors` array is non-empty in {@link resolveOptions}'s return).
 */
export type ResolvedFindMatchesOptions = {
  /** Base URL of the GitLab instance (from `GITLAB_URL` env or `gitlab.url` config). */
  gitlabUrl: string;
  /** Branch to scan. */
  branch: string;
  /** Substring filter for project names (optional). */
  repoNameFilter: string | undefined;
  /** Project names to skip. */
  excludeRepos: string[];
  /** Glob patterns for file paths to SCAN. Always an array (empty = scan all). */
  fileInclude: string[];
  /** Glob patterns for file paths to SKIP (gitignore-style). Always an array. */
  fileExclude: string[];
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
  /** Path to write performance metrics (NDJSON); `undefined` → no metrics file. */
  metricsFile: string | undefined;
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
  | { ok: true; resolved: ResolvedFindMatchesOptions }
  | { ok: false; errors: ResolveError[] };

/**
 * Resolve every `find-matches` option using the documented precedence
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
 */
export function resolveOptions(
  strings: readonly string[],
  cliOpts: FindMatchesCliOptions,
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
  const cmdDefaults = config.commands?.['find-matches'];

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

  const resolved: ResolvedFindMatchesOptions = {
    gitlabUrl: gitlabUrl as string, // safe: gated above; errors[] is non-empty if missing
    branch: cliOpts.branch ?? config.defaults?.branch ?? 'develop',
    repoNameFilter:
      cliOpts.repoFilter ?? config.defaults?.repoNameFilter,
    excludeRepos:
      cliOpts.exclude ?? config.defaults?.excludeRepos ?? [],
    fileInclude:
      cliOpts.fileInclude ?? config.defaults?.fileInclude ?? [],
    fileExclude:
      cliOpts.fileExclude ?? config.defaults?.fileExclude ?? [],
    concurrency:
      cliOpts.concurrency ?? cmdDefaults?.concurrency ?? 5,
    output: cliOpts.output ?? cmdDefaults?.output,
    interactive: cliOpts.interactive ?? false,
    enableLogs,
    format: cliOpts.format ?? 'json',
    stdout: cliOpts.stdout ?? false,
    // metricsFile comes ONLY from the CLI flag (diagnostic, opt-in) — never
    // from config or env (spec decision 12).
    metricsFile: cliOpts.metricsFile,
  };

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, resolved };
}
