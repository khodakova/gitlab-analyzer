import { cosmiconfig } from 'cosmiconfig';
import { GitlabAnalyzerConfigSchema, type GitlabAnalyzerConfig } from './schema.ts';

const explorer = cosmiconfig('gitlab-analyzer', {
  cache: false,
  searchPlaces: [
    'gitlab-analyzer.json',
    'gitlab-analyzer.config.json',
    'gitlab-analyzer.config.js',
    'gitlab-analyzer.config.mjs',
    'gitlab-analyzer.config.cjs',
    'gitlab-analyzer.config.ts',
    'package.json',
  ],
});

/**
 * Load and parse the gitlab-analyzer config from disk via cosmiconfig.
 *
 * Returns a fully defaulted {@link GitlabAnalyzerConfig}. When no config
 * file is found anywhere in the search path, returns a fully defaulted
 * object with `gitlab` undefined — the loader is NOT a hard gate, the CLI
 * layer is. Each option is resolved in priority order
 * (CLI flag → env var → config → built-in default) and the user gets a
 * single consolidated error listing every still-missing required field
 * (see `resolveOptions` in `src/cli.ts`).
 *
 * Schema-level errors (invalid URL, forbidden `gitlab.token` due to
 * `.strict()`, etc.) are still surfaced as thrown zod errors — those
 * indicate a user-authored config that is structurally wrong and must be
 * reported as such, not silently coerced to defaults.
 *
 * @throws {ZodError} When the config exists but fails schema validation.
 */
export async function loadConfig(): Promise<GitlabAnalyzerConfig> {
  const result = await explorer.search();
  const raw = result && !result.isEmpty ? (result.config as unknown) : {};
  return GitlabAnalyzerConfigSchema.parse(raw);
}
