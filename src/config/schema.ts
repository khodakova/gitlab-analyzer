import { z } from 'zod';

// SECURITY: gitlab.token is FORBIDDEN in config files (only via PRIVATE_TOKEN env var).
// Use .strict() to reject unknown keys (including token) at the inner gitlab level.
const GitlabSchema = z.object({
  url: z.string().url(),
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
  gitlab: GitlabSchema,
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
