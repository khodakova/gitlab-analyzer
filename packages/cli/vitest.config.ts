import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: [
      // `$` end-anchors make these exact matches, so the broader
      // `@gitlab-analyzer/core` alias cannot shadow the more specific
      // `@gitlab-analyzer/core/internal` subpath.
      {
        find: '@gitlab-analyzer/core/internal$',
        replacement: fileURLToPath(
          new URL('../core/src/internal.ts', import.meta.url),
        ),
      },
      {
        find: '@gitlab-analyzer/core$',
        replacement: fileURLToPath(
          new URL('../core/src/index.ts', import.meta.url),
        ),
      },
    ],
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', '.omo'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/*/index.ts',
      ],
      reporter: ['text', 'html', 'lcov'],
    },
  },
});
