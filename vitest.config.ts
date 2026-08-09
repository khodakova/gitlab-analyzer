import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', '.omo'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        // Sub-folder index.ts files (barrel re-exports) are pure glue and
        // not exercised directly — exclude them. The top-level
        // `src/index.ts` IS measured (it's the library's public surface).
        'src/*/index.ts',
      ],
      reporter: ['text', 'html', 'lcov'],
    },
  },
});
