# @gitlab-analyzer/core

## 0.2.0

### Minor Changes

- a4270ea: New `get-last-commits` command: report the last commit for every selected
  GitLab repository — the branch tip commit (default) or, with `--file <glob>`,
  the last commit touching each file matched by the pattern. JSON/txt report
  with auto-naming, `--stdout`, `-o/--output`, `-c/--concurrency` (default 5),
  repo filters (`-r`, `-e`, `--interactive`) and `--metrics-file`. Per-repo
  branch resolution: `-b` → project `default_branch` → `develop`. This command
  reads no config file (config support is being phased out).

  Also reworks the low-level `getCommits` API helper: it is now typed as
  `Commit[]` and **throws** on HTTP errors instead of silently returning
  `null` (the previous behavior). If you consumed `getCommits` directly and
  relied on the `null` return, handle the thrown error instead. The helper
  accepts `path`, `ref_name`, `since`, `until` and `per_page` parameters.

## 0.1.0

### Minor Changes

- a37ef2b: `fetchFiles` — bulk file download API: walks the repo tree of every
  reachable project, downloads blobs matching glob `patterns` on the given
  branch and hands persistence to the caller via a `saveFile` hook
  (`SaveFileInput.data` is always a full `Buffer`; text of any size is
  embedded as UTF-8 `content`, binaries are reported as `binary`).
  Repo statuses `fetched | not-found | partial | error`, per-file statuses
  `fetched | binary | failed`, unsafe repo paths are skipped, never renamed.
- a37ef2b: Removed `MAX_EMBED_BYTES` (10 MB embed cap) and the `large` status:
  blobs are read fully into memory by design — the `saveFile` hook now always
  receives a `Buffer`, never a `Readable` stream.
