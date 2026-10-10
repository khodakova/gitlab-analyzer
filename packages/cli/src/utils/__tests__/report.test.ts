import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  assertFormatPathConsistency,
  renderReportTxt,
  resolveOutputPath,
  type Report,
} from '../report.ts';

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: mocks.existsSync,
}));

beforeEach(() => {
  mocks.existsSync.mockReset();
  mocks.existsSync.mockReturnValue(false);
});

describe('report > resolveOutputPath', () => {
  it('returns the explicit output path verbatim', () => {
    expect(resolveOutputPath('/tmp/x.json', 'json', '2026-08-13-1536')).toBe(
      '/tmp/x.json',
    );
  });

  it('generates an auto json name when no --output is given', () => {
    mocks.existsSync.mockReturnValue(false);
    expect(resolveOutputPath(undefined, 'json', '2026-08-13-1536')).toBe(
      'find-matches-results-2026-08-13-1536.json',
    );
  });

  it('generates an auto txt name for --format txt', () => {
    mocks.existsSync.mockReturnValue(false);
    expect(resolveOutputPath(undefined, 'txt', '2026-08-13-1536')).toBe(
      'find-matches-results-2026-08-13-1536.txt',
    );
  });

  it('versions the auto name with -1, -2 when the base name exists', () => {
    const base = 'find-matches-results-2026-08-13-1536.json';
    const v1 = 'find-matches-results-2026-08-13-1536-1.json';
    const v2 = 'find-matches-results-2026-08-13-1536-2.json';
    mocks.existsSync
      .mockImplementation((p: string) => p === base || p === v1);
    expect(resolveOutputPath(undefined, 'json', '2026-08-13-1536')).toBe(v2);
  });
});

describe('report > assertFormatPathConsistency', () => {
  it('passes when --output extension matches --format json', () => {
    expect(() =>
      assertFormatPathConsistency('/tmp/r.json', 'json'),
    ).not.toThrow();
  });

  it('passes when --output extension matches --format txt', () => {
    expect(() =>
      assertFormatPathConsistency('/tmp/r.txt', 'txt'),
    ).not.toThrow();
  });

  it('throws when --format txt conflicts with a .json --output', () => {
    expect(() =>
      assertFormatPathConsistency('/tmp/r.json', 'txt'),
    ).toThrow(/conflicts with output path/);
  });

  it('throws when --format json conflicts with a .txt --output', () => {
    expect(() =>
      assertFormatPathConsistency('/tmp/r.txt', 'json'),
    ).toThrow(/conflicts with output path/);
  });

  it('does not throw when the output has no extension', () => {
    expect(() =>
      assertFormatPathConsistency('/tmp/r', 'txt'),
    ).not.toThrow();
  });
});

describe('report > renderReportTxt', () => {
  const report: Report = {
    metadata: {
      generatedAt: '2026-08-13T00:00:00.000Z',
      branch: 'develop',
      searchStrings: ['needle'],
      repoNameFilter: null,
      fileInclude: ['**/*.ts'],
      fileExclude: ['**/*.test.ts'],
      excludeRepos: ['skip-me'],
    },
    repositories: [
      {
        projectId: 1,
        projectName: 'alpha',
        projectDescription: null,
        webUrl: 'https://gitlab/alpha',
        branchExists: true,
        error: null,
        resultsLength: 1,
        results: [
          {
            filename: '/src/a.ts',
            matches: ['needle'],
            content: ['line1', 'needle'],
          },
        ],
      },
    ],
  };

  it('includes metadata lines and per-repo file blocks', () => {
    const txt = renderReportTxt(report);
    expect(txt).toContain('Generated at: 2026-08-13T00:00:00.000Z');
    expect(txt).toContain('Branch: develop');
    expect(txt).toContain('File include: **/*.ts');
    expect(txt).toContain('File exclude: **/*.test.ts');
    expect(txt).toContain('Excluded repos: skip-me');
    expect(txt).toContain('---- alpha (id: 1) ----');
    expect(txt).toContain('> /src/a.ts');
    expect(txt).toContain('matched: needle');
  });

  it('shows (none) for empty fileInclude / fileExclude arrays', () => {
    const emptyReport: Report = {
      ...report,
      metadata: {
        ...report.metadata,
        fileInclude: [],
        fileExclude: [],
      },
    };
    const txt = renderReportTxt(emptyReport);
    expect(txt).toContain('File include: (none)');
    expect(txt).toContain('File exclude: (none)');
  });

  it('includes `files analyzed: N` line in stdout only', () => {
    const txt = renderReportTxt(report, 42);
    expect(txt).toContain('files analyzed: 42');

    // And the string is NOT in the JSON serialization (stdout-only field).
    expect(JSON.stringify(report)).not.toContain('files analyzed');
  });

  it('falls back to 0 when filesScanned is not passed', () => {
    const txt = renderReportTxt(report);
    expect(txt).toContain('files analyzed: 0');
  });
});

// ---------- Uncovered cases from docs/test-cases.md section 8 ----------

describe('report > extname edge cases (case 57)', () => {
  it('case 57: -o "x." — extname is "." → conflict error even with matching json format', () => {
    // extname('x.') === '.' which is !== '.json' → hasExtension fails → throw.
    // A file literally named "x." is unusable for the report — pin the check.
    expect(() =>
      assertFormatPathConsistency('x.', 'json'),
    ).toThrow(/conflicts with output path/);
  });

  it('case 57: -o "./x/.json" — extname is "" → NO check, file .json written anyway (pin)', () => {
    // extname('./x/.json') === '' (the basename is empty; the path ends with
    // a slash-looking segment) → the guard returns early → no conflict thrown
    // even though the resulting file would be named ".json".
    expect(() =>
      assertFormatPathConsistency('./x/.json', 'txt'),
    ).not.toThrow();
  });

  it('case 44 (partial): explicit --output is returned verbatim (no -1 versioning even if it exists)', () => {
    // Versioning applies ONLY to auto names. existsSync is mocked false here;
    // the point is resolveOutputPath never consults it for explicit paths.
    mocks.existsSync.mockReturnValue(true);
    expect(resolveOutputPath('/tmp/exists.json', 'json', '2026-08-13-1536')).toBe(
      '/tmp/exists.json',
    );
    expect(mocks.existsSync).not.toHaveBeenCalled();
  });
});
