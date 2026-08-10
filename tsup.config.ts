import { defineConfig } from 'tsup'

/**
 * tsup build config for `gitlab-analyzer`.
 *
 * Two entries, dual ESM + CJS output:
 *
 * - `index` — public library API (`findStrings`, `loadConfig`, types).
 *   Emits `dist/index.js` (ESM), `dist/index.cjs` (CJS), `dist/index.d.ts`
 *   (types). Tree-shakes unused source modules into the bundle so the
 *   consumer install surface is just `dist/{index.js,index.cjs,index.d.ts}`
 *   instead of the full per-file tree we had under plain `tsc`.
 *
 * - `cli`  — the `gitlab-analyzer` binary (`dist/cli.js`). ESM only because
 *   it's a bin entry; CJS variant of a CLI would force the consumer's Node
 *   process into CJS mode for the entry point, which contradicts our
 *   `"type": "module"` package setting. Shebang is injected via `banner`
 *   because tsup strips source shebangs by default (see
 *   https://tsup.egoist.dev/#inject-banner). `chmod +x` happens
 *   automatically when npm installs a `bin` field, so we don't add a
 *   post-build hook here.
 *
 * Externalisation: all runtime dependencies (`axios`, `commander`, etc.) are
 * listed in `external` so they stay in `dependencies` and get installed
 * alongside the package, instead of being inlined into our bundles. This
 * keeps our install footprint small AND lets npm dedupe across packages
 * that share the same `axios` instance, which is the standard convention
 * for Node libraries.
 *
 * `splitting: false` is required for CJS output (esbuild forbids
 * code-splitting with CJS). With our 4-entry surface it would not gain much
 * anyway — the shared graph between `index` and `cli` is small.
 *
 * `clean: true` wipes `dist/` before the first build so leftovers from a
 * previous `tsc` run (the old `dist/cli.js`, `dist/api/*`, `dist/utils/*`,
 * `dist/types.*`, etc.) don't pollute the new tarball.
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
      'commander',
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
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    outDir: 'dist',
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
    treeshake: true,
    target: 'node20',
    platform: 'node',
    banner: { js: '#!/usr/bin/env node' },
    external: [
      'axios',
      'colorette',
      'commander',
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
