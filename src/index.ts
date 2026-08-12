/**
 * Public API for the `gitlab-analyzer` library.
 *
 * Consumers can either use the CLI (`gitlab-analyzer find-strings ...`) or
 * import these symbols directly:
 *
 * ```ts
 * import {
 *   findStrings,
 *   loadConfig,
 *   type FindStringsOptions,
 *   type MatchResult,
 * } from 'gitlab-analyzer';
 *
 * const config = await loadConfig();
 * const results = await findStrings({
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
 * `src/commands/find-strings.ts`).
 */

// Runtime sentinel — gives v8 coverage a statement to mark as executed
// when consumers `import` from this barrel. The `void` makes the intent
// explicit (this is not user-facing state, just a coverage anchor).
export const __reExportSentinel = true;
void __reExportSentinel;

export { findStrings } from './commands/find-strings.ts';
export type {
  FindStringsOptions,
  MatchResult,
} from './commands/find-strings.ts';
export type { RepoInfo } from './types.ts';
export { loadConfig } from './config/load.ts';
