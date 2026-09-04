import type { GitlabAnalyzerConfig } from '@gitlab-analyzer/core/internal';

/**
 * Which repositories to include in the report file. `all` (default) keeps
 * every scanned repo; `found` keeps only repos with matches; `not-found`
 * keeps only repos without matches (errors are excluded from both).
 */
export type OutputFilter = 'found' | 'not-found' | 'all';

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
  /** Which repositories to include in the report file (`found`/`not-found`/`all`). */
  outputFilter?: OutputFilter;
  /** Path to write performance metrics (NDJSON). Diagnostic; only via CLI flag. */
  metricsFile?: string;
  /** From global `--private-token`. Overrides PRIVATE_TOKEN env. */
  privateToken?: string;
  /** From global `--gitlab-url`. Overrides GITLAB_URL env and gitlab.url config. */
  gitlabUrl?: string;
};

/**
 * Fully resolved `find-matches` options — every required field is present
 * (or the `errors` array is non-empty in {@link resolveOptions}'s return).
 */
export type ResolvedFindMatchesOptions = {
  /** Base URL of the GitLab instance (from `GITLAB_URL` env or `gitlab.url` config). */
  gitlabUrl: string;
  /** Effective GitLab token (CLI > env). Config never (security policy). */
  privateToken: string;
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
  /** Which repositories to include in the report file (`found`/`not-found`/`all`). */
  outputFilter: OutputFilter;
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
 *   - `gitlabUrl`  — from `--gitlab-url` CLI flag, `GITLAB_URL` env (via
 *                    dotenv-loaded `.env`) or `gitlab.url` in `gitlab-analyzer.json`
 *   - `PRIVATE_TOKEN` — from `--private-token` CLI flag or env only;
 *                       intentionally NEVER read from config
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

  // Required: gitlabUrl — CLI flag > env > config.
  const gitlabUrl =
    cliOpts.gitlabUrl ?? process.env.GITLAB_URL ?? config.gitlab?.url;
  if (!gitlabUrl) {
    errors.push({
      field: 'gitlabUrl',
      message:
        'Set GITLAB_URL in the environment (or .env), pass --gitlab-url, or add "gitlab.url" to gitlab-analyzer.json.',
    });
  }

  // Required: PRIVATE_TOKEN — CLI flag > env. Config NEVER (security policy).
  // Empty/whitespace CLI token counts as "not set" (falls through to env).
  const cliToken = cliOpts.privateToken?.trim();
  const privateToken = cliToken || process.env.PRIVATE_TOKEN;
  if (!privateToken) {
    errors.push({
      field: 'PRIVATE_TOKEN',
      message:
        'Set PRIVATE_TOKEN in the environment (or .env), or pass --private-token. Tokens are never read from config files.',
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
    privateToken: privateToken as string, // safe: gated above; errors[] is non-empty if missing
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
    outputFilter:
      cliOpts.outputFilter ??
      cmdDefaults?.outputFilter ??
      config.defaults?.outputFilter ??
      'all',
    // metricsFile comes ONLY from the CLI flag (diagnostic, opt-in) — never
    // from config or env (spec decision 12).
    metricsFile: cliOpts.metricsFile,
  };

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, resolved };
}

/**
 * Report output formats supported by `fetch-files`: structured JSON,
 * line-delimited JSON (one record per line — stream-friendly), or plain text.
 */
export type FetchFilesOutputFormat = 'json' | 'ndjson' | 'txt';

/**
 * CLI options for the `fetch-files` subcommand. Produced by commander and
 * passed into {@link resolveFetchFilesOptions}.
 *
 * Same precedence model as {@link FindMatchesCliOptions}, but there is no
 * `commands.fetch-files` config block — config contributes only
 * `defaults.*` (branch, repoNameFilter, excludeRepos, fileExclude,
 * enableLogs).
 */
export type FetchFilesCliOptions = {
  repoFilter?: string;
  exclude?: string[];
  branch?: string;
  /** Glob patterns to SKIP (commander returns string[] from comma-split). */
  fileExclude?: string[];
  /** Output DIRECTORY (not a file path); `undefined` → created in cwd. */
  output?: string;
  concurrency?: number;
  interactive?: boolean;
  enableLogs?: boolean;
  format?: FetchFilesOutputFormat;
  /** Which repositories get artifacts (`found`/`all`). CLI-only, no config. */
  outputFilter?: OutputFilter;
  /** Path to write performance metrics (NDJSON). Diagnostic; only via CLI flag. */
  metricsFile?: string;
  /** From global `--private-token`. Overrides PRIVATE_TOKEN env. */
  privateToken?: string;
  /** From global `--gitlab-url`. Overrides GITLAB_URL env and gitlab.url config. */
  gitlabUrl?: string;
};

/**
 * Fully resolved `fetch-files` options — every required field is present
 * (or the `errors` array is non-empty in {@link resolveFetchFilesOptions}'s
 * return).
 */
export type ResolvedFetchFilesOptions = {
  /** Base URL of the GitLab instance (from `GITLAB_URL` env or `gitlab.url` config). */
  gitlabUrl: string;
  /** Effective GitLab token (CLI > env). Config never (security policy). */
  privateToken: string;
  /** Branch to fetch files from. */
  branch: string;
  /** Substring filter for project names (optional). */
  repoNameFilter: string | undefined;
  /** Project names to skip. */
  excludeRepos: string[];
  /** Glob patterns selecting which files to fetch. Required: at least one. */
  patterns: string[];
  /** Glob patterns for file paths to SKIP (gitignore-style). Always an array. */
  fileExclude: string[];
  /** Output directory; `undefined` → directory is created in cwd. */
  output: string | undefined;
  /** Max parallel archive-fetch + zip-parse tasks. */
  concurrency: number;
  /** Whether to prompt the user to pick repos before fetching. */
  interactive: boolean;
  /** Whether debug/API logging is enabled (CLI > ENABLE_LOGS > defaults.enableLogs). */
  enableLogs: boolean;
  /** Report format: `json` (default), `ndjson` or `txt`. */
  format: FetchFilesOutputFormat;
  /** Which repositories get artifacts: `found` (default) or `all`. CLI-only. */
  outputFilter: OutputFilter;
  /** Path to write performance metrics (NDJSON); `undefined` → no metrics file. */
  metricsFile: string | undefined;
};

/**
 * Resolve every `fetch-files` option using the documented precedence
 * (CLI → env → config → built-in default) and collect ALL missing-required
 * fields into a single structured error list. Mirrors {@link resolveOptions},
 * except there is no `commands.fetch-files` config block and the required
 * positional input is file glob patterns instead of search strings.
 *
 * Required (must be present from at least one source):
 *
 *   - `gitlabUrl`  — from `--gitlab-url` CLI flag, `GITLAB_URL` env (via
 *                    dotenv-loaded `.env`) or `gitlab.url` in `gitlab-analyzer.json`
 *   - `PRIVATE_TOKEN` — from `--private-token` CLI flag or env only;
 *                       intentionally NEVER read from config
 *                       (security policy — see README "Security: tokens")
 *   - At least one non-empty glob pattern
 */
export function resolveFetchFilesOptions(
  patterns: readonly string[],
  cliOpts: FetchFilesCliOptions,
  config: GitlabAnalyzerConfig,
): { ok: true; resolved: ResolvedFetchFilesOptions } | { ok: false; errors: ResolveError[] } {
  const errors: ResolveError[] = [];

  // Required: gitlabUrl — CLI flag > env > config.
  const gitlabUrl =
    cliOpts.gitlabUrl ?? process.env.GITLAB_URL ?? config.gitlab?.url;
  if (!gitlabUrl) {
    errors.push({
      field: 'gitlabUrl',
      message:
        'Set GITLAB_URL in the environment (or .env), pass --gitlab-url, or add "gitlab.url" to gitlab-analyzer.json.',
    });
  }

  // Required: PRIVATE_TOKEN — CLI flag > env. Config NEVER (security policy).
  // Empty/whitespace CLI token counts as "not set" (falls through to env).
  const cliToken = cliOpts.privateToken?.trim();
  const privateToken = cliToken || process.env.PRIVATE_TOKEN;
  if (!privateToken) {
    errors.push({
      field: 'PRIVATE_TOKEN',
      message:
        'Set PRIVATE_TOKEN in the environment (or .env), or pass --private-token. Tokens are never read from config files.',
    });
  }

  // Required: at least one non-empty glob pattern (empty strings don't count).
  const hasPattern = patterns.some((p) => p.trim().length > 0);
  if (!hasPattern) {
    errors.push({
      field: 'patterns',
      message: 'Provide at least one file glob pattern (e.g. "**/*.ts").',
    });
  }

  // `enableLogs` — CLI flag > ENABLE_LOGS env > config.defaults.enableLogs >
  // built-in default (false). Same truthy set as resolveOptions ('1', 'true',
  // 'yes', 'on', case-insensitive).
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

  const resolved: ResolvedFetchFilesOptions = {
    gitlabUrl: gitlabUrl as string, // safe: gated above; errors[] is non-empty if missing
    privateToken: privateToken as string, // safe: gated above; errors[] is non-empty if missing
    branch: cliOpts.branch ?? config.defaults?.branch ?? 'develop',
    repoNameFilter:
      cliOpts.repoFilter ?? config.defaults?.repoNameFilter,
    excludeRepos:
      cliOpts.exclude ?? config.defaults?.excludeRepos ?? [],
    patterns: [...patterns],
    fileExclude:
      cliOpts.fileExclude ?? config.defaults?.fileExclude ?? [],
    output: cliOpts.output,
    concurrency: cliOpts.concurrency ?? 5,
    interactive: cliOpts.interactive ?? false,
    enableLogs,
    format: cliOpts.format ?? 'json',
    outputFilter: cliOpts.outputFilter ?? 'found',
    // metricsFile comes ONLY from the CLI flag (diagnostic, opt-in) — never
    // from config or env (same spec decision as find-matches).
    metricsFile: cliOpts.metricsFile,
  };

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, resolved };
}
