# @gitlab-analyzer/core

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
