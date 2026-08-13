/**
 * Compatibility re-export for library consumers of the pre-monorepo
 * `gitlab-analyzer` npm package.
 *
 * Before the monorepo restructure, the single `gitlab-analyzer` package
 * shipped BOTH the `gitlab-analyzer` binary and the library API
 * (`findStrings`, `loadConfig`, `configureLogger`, types). After the split:
 *
 * - the binary lives in this `cli` package (which keeps the `gitlab-analyzer`
 *   npm name), and
 * - the authoritative library API moved to `@gitlab-analyzer/core`.
 *
 * This module re-exports core's public API so existing
 * `import { findStrings } from 'gitlab-analyzer'` consumers keep working,
 * while `@gitlab-analyzer/core` is the new target for library use.
 *
 * It is a separate entry from `src/cli.ts` (the binary) so the re-export
 * never shadows the `gitlab-analyzer` command.
 */
export * from '@gitlab-analyzer/core';
