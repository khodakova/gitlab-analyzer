/**
 * Internal API surface for `@gitlab-analyzer/core`.
 *
 * NOT part of the package's public contract — this subpath exists so the
 * sibling `cli` (and future `mcp`) packages can reuse the shared low-level
 * pieces (HTTP client, project-list fetch, progress renderer, config-schema
 * type, GitLab API types) without polluting the public `index.ts`. Consumers
 * outside this repo should never `import ... from '@gitlab-analyzer/core/internal'`.
 */

export { axiosInstance } from './api/config.ts';
export { getAllProjects } from './utils/get-projects.ts';
export { getProjectArchive } from './api/project-archive.ts';
export { findStrInZip } from './commands/find-matches.ts';
export { ProgressRenderer } from './utils/progress.ts';
export type { GitlabAnalyzerConfig } from './config/schema.ts';
export type { SearchProjectsItem } from './types.ts';
export type { RepoTiming, SearchMetrics } from './commands/find-matches.ts';
