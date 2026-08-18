---
'@gitlab-analyzer/core': minor
---

Add report format selection and a self-describing output report.

- New `--format <txt|json>` flag (default `json`) selects the report format;
  `--format txt` produces human-readable text.
- New `--stdout` flag writes the report to stdout in addition to the file.
- Output routing changed: without `--output` an auto-named
  `find-matches-results-<DATE>.<ext>` file is created (with a `-1`, `-2`, …
  version suffix when the name already exists) instead of writing to stdout.
- `--format` conflicting with the extension of an explicit `--output` path
  (e.g. `--format txt -o result.json`) fails with an error and writes nothing.
- The CLI report is now a self-describing object with a `metadata` block
  (generatedAt, branch, searchStrings, repoNameFilter, pathFilter,
  includeTests, excludeRepos) and a `repositories` array — one entry per
  scanned repo (projectId/projectName/projectDescription/webUrl/branchExists/
  error/resultsLength/results), including repos that errored or matched
  nothing. This replaces the previous bare-array output (breaking change for
  consumers parsing the old shape).
- `findMatches` `onProgress` now passes a 4th `error` argument when a repo's
  archive fetch fails, so callers can surface why a repo was skipped. The
  library return shape is unchanged.
