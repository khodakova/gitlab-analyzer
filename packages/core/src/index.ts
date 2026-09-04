/**
 * Public API for the `gitlab-analyzer` library.
 *
 * Consumers can either use the CLI (`gitlab-analyzer find-matches ...`) or
 * import these symbols directly:
 *
 * ```ts
 * import {
 *   findMatches,
 *   loadConfig,
 *   configureLogger,
 *   type FindMatchesOptions,
 *   type MatchResult,
 * } from 'gitlab-analyzer';
 *
 * const config = await loadConfig();
 *
 * // Optional: turn on debug/API logging for library calls.
 * configureLogger({ enabled: true });
 *
 * const results = await findMatches({
 *   searchStrings: ['my-secret'],
 *   branch: config.defaults.branch,
 *   onProgress: (done, total, repo) =>
 *     process.stderr.write(`[${done}/${total}] ${repo}\n`),
 * });
 *
 * console.log(JSON.stringify(results, null, 2));
 * ```
 *
 * Configuration schema types are intentionally NOT re-exported from this
 * module — consumers go through {@link loadConfig} which returns a fully
 * validated {@link import('./config/load.ts').LoadedConfig}. The shape of
 * each {@link MatchResult} is documented on the type itself (see
 * `src/commands/find-matches.ts`).
 */

// Runtime sentinel — gives v8 coverage a statement to mark as executed
// when consumers `import` from this barrel. The `void` makes the intent
// explicit (this is not user-facing state, just a coverage anchor).
export const __reExportSentinel = true;
void __reExportSentinel;

export { findMatches } from './commands/find-matches.ts';
export type {
  FindMatchesOptions,
  MatchResult,
  FileFilters,
} from './commands/find-matches.types.ts';
export { fetchFiles } from './commands/fetch-files.ts';
export type {
  FetchFilesOptions,
  FetchFilesResult,
  FetchedRepo,
  FetchedFile,
  FetchedFileStatus,
  RepoStatus,
  SaveFileInput,
  SaveFileResult,
} from './commands/fetch-files.types.ts';
export type { RepoInfo } from './types.ts';
export { loadConfig } from './config/load.ts';
export { configureLogger, logger, flushLogs, formatDuration } from './utils/logger.ts';
