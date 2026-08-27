import { defineConfig } from 'tsup'

/**
 * tsup build config for `@gitlab-analyzer/core` (the library package).
 *
 * Two entries, dual ESM + CJS output:
 *
 * - `index`    — public library API (`findMatches`, `loadConfig`,
 *   `configureLogger`, types). Emits `dist/index.js` (ESM),
 *   `dist/index.cjs` (CJS), `dist/index.d.ts` (types). Tree-shakes unused
 *   source modules into the bundle so the consumer install surface is just
 *   `dist/{index.js,index.cjs,index.d.ts}`.
 *
 * - `internal` — the internal subpath (`@gitlab-analyzer/core/internal`,
 *   `dist/internal.{js,cjs,d.ts}`) exposing shared low-level pieces
 *   (axiosInstance, getAllProjects, ProgressRenderer, config/API types) to
 *   the sibling `cli` / `mcp` packages without enlarging the public API.
 *
 * Externalisation: all runtime dependencies are listed in `external` so they
 * stay in `dependencies` and get installed alongside the package instead of
 * being inlined into the bundles. `splitting: false` is required for CJS
 * output (esbuild forbids code-splitting with CJS).
 */
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    outDir: 'dist',
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    treeshake: true,
    target: 'node20',
    platform: 'node',
    external: [
      'axios',
      'colorette',
      'cosmiconfig',
      'dotenv',
      'jszip',
      'p-limit',
      'semver',
      'xlsx',
      'zod',
    ],
  },
  {
    entry: { internal: 'src/internal.ts' },
    format: ['esm', 'cjs'],
    outDir: 'dist',
    dts: true,
    sourcemap: true,
    clean: false,
    splitting: false,
    treeshake: true,
    target: 'node20',
    platform: 'node',
    external: [
      'axios',
      'colorette',
      'cosmiconfig',
      'dotenv',
      'jszip',
      'p-limit',
      'semver',
      'xlsx',
      'zod',
    ],
  },
])
