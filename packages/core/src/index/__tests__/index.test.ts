import { describe, it, expect } from 'vitest';
import * as indexModule from '../../index.ts';

describe('index > public API surface', () => {
  it('re-exports the findStrings function', () => {
    expect(typeof indexModule.findStrings).toBe('function');
  });

  it('re-exports the loadConfig function', () => {
    expect(typeof indexModule.loadConfig).toBe('function');
  });

  it('exposes the MatchResult type via findStrings return type', () => {
    // Type-only check: invoking the type-level helpers at compile time is
    // enough — no need to actually await the runtime call. Assigning the
    // inferred return type proves MatchResult re-exports compile.
    type _MatchResult = Awaited<ReturnType<typeof indexModule.findStrings>>[number];
    const typedLocal: _MatchResult | undefined = undefined;
    expect(typedLocal).toBeUndefined();
  });

  it('exposes the FindStringsOptions type via findStrings parameter type', () => {
    // Type-only check: a typed declaration with the optional fields proves
    // the FindStringsOptions export is in scope. No runtime invocation.
    type _Options = indexModule.FindStringsOptions;
    const typedLocal: _Options = {
      searchStrings: ['a', 'b'],
      branch: 'develop',
      repoNameFilter: 'frontend',
      excludeRepos: ['wip'],
      pathFilter: '/src/',
      includeTests: false,
      concurrency: 3,
    };
    expect(typedLocal.searchStrings).toEqual(['a', 'b']);
  });

  it('does NOT re-export internal config-schema types directly', () => {
    // Defensive: users must go through `loadConfig()`, not reach into the
    // raw zod schema. We assert by name (these should be undefined).
    const mod = indexModule as unknown as Record<string, unknown>;
    expect(mod.GitlabAnalyzerConfigSchema).toBeUndefined();
    expect(mod.GitlabAnalyzerConfig).toBeUndefined();
  });

  it('exposes the public runtime values (findStrings, loadConfig, logger, coverage sentinel)', () => {
    // The sentinel `__reExportSentinel` exists purely to anchor v8 coverage
    // on this pure-re-export file; assert it is present so future
    // refactors do not silently drop it.
    const exportedNames = Object.keys(indexModule).sort();
    expect(exportedNames).toEqual([
      '__reExportSentinel',
      'configureLogger',
      'findStrings',
      'flushLogs',
      'formatDuration',
      'loadConfig',
      'logger',
    ]);
  });

  it('re-exports the logger configuration helpers', () => {
    expect(typeof indexModule.configureLogger).toBe('function');
    expect(typeof indexModule.logger?.debug).toBe('function');
    expect(typeof indexModule.logger?.info).toBe('function');
    expect(typeof indexModule.logger?.success).toBe('function');
    expect(typeof indexModule.logger?.warn).toBe('function');
    expect(typeof indexModule.logger?.error).toBe('function');
    expect(typeof indexModule.flushLogs).toBe('function');
    expect(typeof indexModule.formatDuration).toBe('function');
  });
});
