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

export async function loadConfig(): Promise<GitlabAnalyzerConfig> {
  const result = await explorer.search();

  if (!result || result.isEmpty) {
    throw new Error(
      'No configuration found.\n' +
      'Create gitlab-analyzer.json in cwd (or ~/.config/gitlab-analyzer/config.json) with at least:\n' +
      '  { "gitlab": { "url": "https://your-gitlab.example.com" } }'
    );
  }

  return GitlabAnalyzerConfigSchema.parse(result.config);
}
