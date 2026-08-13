import { defineConfig } from 'tsup';

/**
 * tsup build config for `gitlab-analyzer` (the CLI package, which also
 * re-exports `@gitlab-analyzer/core`'s public API for library consumers).
 *
 * Two entries:
 *
 * - `cli`   — the `gitlab-analyzer` binary (`dist/cli.js`). ESM only (it's a
 *   bin entry); shebang injected via `banner` because tsup strips source
 *   shebangs by default. `chmod +x` happens automatically when npm installs
 *   a `bin` field.
 * - `index` — re-export surface (`export * from '@gitlab-analyzer/core'`) so
 *   `import { findStrings } from 'gitlab-analyzer'` keeps working for the
 *   pre-monorepo library consumers. Dual ESM + CJS + dts like core.
 *
 * Externalisation: `@gitlab-analyzer/core`, `commander`, `enquirer` stay in
 * `dependencies` (the CLI shell + local picker use them at runtime) and are
 * external so they resolve from node_modules at runtime.
 */
export default defineConfig([
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    outDir: 'dist',
    dts: false,
    sourcemap: true,
    clean: true,
    splitting: false,
    treeshake: true,
    target: 'node20',
    platform: 'node',
    banner: { js: '#!/usr/bin/env node' },
    external: ['@gitlab-analyzer/core', '@gitlab-analyzer/core/internal', 'commander', 'enquirer'],
  },
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    outDir: 'dist',
    dts: true,
    sourcemap: true,
    clean: false,
    splitting: false,
    treeshake: true,
    target: 'node20',
    platform: 'node',
    external: ['@gitlab-analyzer/core', '@gitlab-analyzer/core/internal', 'commander', 'enquirer'],
  },
])
