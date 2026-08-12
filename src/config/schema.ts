import { z } from 'zod';

// SECURITY: gitlab.token is FORBIDDEN in config files (only via PRIVATE_TOKEN env var).
// Use .strict() to reject unknown keys (including token) at the inner gitlab level.
//
// `gitlab.url` is OPTIONAL — the runtime resolution prefers GITLAB_URL env
// var over `config.gitlab.url` (see `resolveOptions` in `src/cli.ts`). A
// valid config may omit `gitlab` entirely if the user supplies GITLAB_URL
// via `.env` or the shell.
const GitlabSchema = z.object({
  url: z.string().url().optional(),
}).strict();

const DefaultsSchema = z.object({
  branch: z.string().default('develop'),
  repoNameFilter: z.string().optional(),
  excludeRepos: z.array(z.string()).default([]),
  pathFilter: z.string().optional(),
  includeTests: z.boolean().default(false),
});

const FindStringsCommandSchema = z.object({
  concurrency: z.number().int().positive().default(5),
  output: z.string().optional(),
});

export const GitlabAnalyzerConfigSchema = z.object({
  // `gitlab` is optional at the top level too — empty config parses cleanly,
  // letting `loadConfig()` succeed even when no file is on disk. The CLI
  // layer reports missing required options in one shot instead of the
  // loader failing first.
  gitlab: GitlabSchema.optional(),
  defaults: DefaultsSchema.default(() => ({
    branch: 'develop',
    excludeRepos: [] as string[],
    includeTests: false,
  })),
  commands: z.object({
    'find-strings': FindStringsCommandSchema.default(() => ({
      concurrency: 5,
    })),
  }).default(() => ({
    'find-strings': { concurrency: 5 },
  })),
});

export type GitlabAnalyzerConfig = z.infer<typeof GitlabAnalyzerConfigSchema>;
