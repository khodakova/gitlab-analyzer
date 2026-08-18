import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import type { MatchResult } from '@gitlab-analyzer/core';
import type { ResolvedFindMatchesOptions } from './options.ts';

/**
 * Normalized report format, either the JSON object shape (default) or the
 * human-readable text render.
 */
export type ReportFormat = 'txt' | 'json';

/**
 * A single repository entry inside the report's `repositories` array.
 * Combines the per-repo identity/metadata with the search results and any
 * error that occurred while fetching that repo's archive.
 */
export type ReportRepository = {
  projectId: number;
  projectName: string;
  projectDescription: string | null;
  webUrl: string | null;
  branchExists: boolean;
  error: string | null;
  resultsLength: number;
  results: MatchResult['results'];
};

/**
 * Full report written to file/stdout. Replaces the old bare-array output so
 * the report self-describes the run (when, which branch, which repos, which
 * strings, filters) alongside the per-repo results.
 */
export type Report = {
  metadata: {
    generatedAt: string;
    branch: string;
    searchStrings: string[];
    repoNameFilter: string | null;
    /** Glob patterns for file paths to SCAN (always an array; empty = scan all). */
    fileInclude: string[];
    /** Glob patterns for file paths to SKIP (always an array; empty = no exclude). */
    fileExclude: string[];
    excludeRepos: string[];
  };
  repositories: ReportRepository[];
};

/**
 * True when the error likely means "the requested branch does not exist" on
 * that repo (GitLab returns HTTP 404 / "not found" for a missing sha).
 * Used to drive `branchExists` in the report. This is a heuristic — a repo
 * that is private/archived/removed can also yield 404.
 */
export function isBranchMissingError(message: string): boolean {
  return /\b404\b/i.test(message) || /not found/i.test(message);
}

/**
 * True when `path` ends with the given extension (case-insensitive).
 */
function hasExtension(path: string, ext: string): boolean {
  return extname(path).toLowerCase() === ext.toLowerCase();
}

/**
 * Resolve the output path for the report.
 *
 * - If `--output` is provided, it is used verbatim (after a format/vs-extension
 *   conflict check) and overrides any auto-generated name.
 * - Otherwise an auto name `find-matches-results-<DATE>.<ext>` is generated in
 *   the current directory; if a file with that name already exists a numeric
 *   suffix is appended before the extension (`-1`, `-2`, …) until a free name
 *   is found.
 *
 * @param output - Explicit `--output` path, or `undefined` for auto-naming.
 * @param format - Report format, drives the extension of the auto name.
 * @param date - Timestamp label embedded in the auto name.
 * @returns The concrete path to write to.
 */
export function resolveOutputPath(
  output: string | undefined,
  format: ReportFormat,
  date: string,
): string {
  if (output) {
    return output;
  }
  const ext = format === 'txt' ? '.txt' : '.json';
  const base = `find-matches-results-${date}${ext}`;
  if (!existsSync(base)) {
    return base;
  }
  // Version existing auto-named files: -1, -2, ... up to a free name.
  const stem = `find-matches-results-${date}`;
  let version = 1;
  let candidate = `${stem}-${version}${ext}`;
  while (existsSync(candidate)) {
    version++;
    candidate = `${stem}-${version}${ext}`;
  }
  return candidate;
}

/**
 * Throw when `--format` conflicts with the extension of an explicit `--output`
 * path (e.g. `--format txt -o result.json`). The user is expected to align
 * format and extension; silently picking one would be surprising.
 *
 * @throws {Error} On a mismatch between format and the output path extension.
 */
export function assertFormatPathConsistency(
  output: string | undefined,
  format: ReportFormat,
): void {
  if (!output) {
    return;
  }
  const ext = extname(output);
  if (ext === '') {
    // No extension — nothing to conflict with.
    return;
  }
  const expected = format === 'txt' ? '.txt' : '.json';
  if (!hasExtension(output, expected)) {
    throw new Error(
      `--format ${format} conflicts with output path "${output}" (expected ${expected} extension).`,
    );
  }
}

/**
 * Render the report as human-readable text. Mirrors the JSON structure
 * (metadata first, then per-repo results with full file content).
 *
 * `filesScanned` is an optional stdout-only summary (E.14): the total number
 * of files that passed both filters across all repos. It is NOT part of the
 * Report metadata — the JSON file shape is unchanged. When omitted (e.g.
 * from a unit test without metrics), we print `0`.
 */
export function renderReportTxt(report: Report, filesScanned?: number): string {
  const lines: string[] = [];
  const { metadata, repositories } = report;

  lines.push('GitLab strings report');
  lines.push('====================');
  lines.push(`Generated at: ${metadata.generatedAt}`);
  lines.push(`Branch: ${metadata.branch}`);
  lines.push(`Search strings: ${metadata.searchStrings.join(', ') || '(none)'}`);
  lines.push(`Repo name filter: ${metadata.repoNameFilter ?? '(none)'}`);
  lines.push(
    `File include: ${metadata.fileInclude.length > 0 ? metadata.fileInclude.join(', ') : '(none)'}`,
  );
  lines.push(
    `File exclude: ${metadata.fileExclude.length > 0 ? metadata.fileExclude.join(', ') : '(none)'}`,
  );
  lines.push(
    `Excluded repos: ${metadata.excludeRepos.length > 0 ? metadata.excludeRepos.join(', ') : '(none)'}`,
  );
  lines.push(
    `Repositories scanned: ${repositories.length}`,
  );
  // E.14 — stdout-only summary of files that passed both filters. NOT part
  // of the Report metadata / JSON file shape.
  lines.push(`проанализировано файлов: ${filesScanned ?? 0}`);
  lines.push('');

  for (const repo of repositories) {
    lines.push(`---- ${repo.projectName} (id: ${repo.projectId}) ----`);
    if (repo.projectDescription) {
      lines.push(`Description: ${repo.projectDescription}`);
    }
    if (repo.webUrl) {
      lines.push(`URL: ${repo.webUrl}`);
    }
    lines.push(`Branch exists: ${repo.branchExists ? 'yes' : 'no'}`);
    if (repo.error) {
      lines.push(`Error: ${repo.error}`);
    }
    lines.push(`Matches: ${repo.resultsLength} file(s)`);

    for (const file of repo.results) {
      lines.push('');
      lines.push(`  > ${file.filename}`);
      lines.push(`    matched: ${file.matches.join(', ')}`);
      if (file.content.length > 0) {
        for (const line of file.content) {
          lines.push(`    ${line}`);
        }
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build the report object from the resolved options, the scanned repo list,
 * the search results, and the per-repo error map gathered via `onProgress`.
 *
 * `repositories` lists EVERY repo that was actually scanned (selected in
 * interactive mode, or the full filtered set headless), including those with
 * zero matches and those that errored — so the report is a faithful audit of
 * what was searched.
 */
export function buildReport(
  resolvedOptions: Pick<
    ResolvedFindMatchesOptions,
    'branch' | 'repoNameFilter' | 'fileInclude' | 'fileExclude' | 'excludeRepos' | 'format' | 'stdout'
  >,
  strings: string[],
  scannedRepos: ReportRepository[],
): Report {
  // scannedRepos is already the final, per-repo list the caller assembled.
  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      branch: resolvedOptions.branch,
      searchStrings: strings,
      repoNameFilter: resolvedOptions.repoNameFilter ?? null,
      fileInclude: resolvedOptions.fileInclude,
      fileExclude: resolvedOptions.fileExclude,
      excludeRepos: resolvedOptions.excludeRepos,
    },
    repositories: scannedRepos,
  };
}

/**
 * Local date-time label used in auto-generated report filenames, e.g.
 * `2026-08-13-1536`. Format is not contractual — it only needs to be unique
 * enough per run and readable as a timestamp.
 */
export function formatDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  );
}
