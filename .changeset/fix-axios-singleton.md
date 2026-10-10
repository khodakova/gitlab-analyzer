---
"@gitlab-analyzer/core": patch
---

Fix: requests made through the shared axios instance no longer fail with
"Invalid URL" when the CLI runs outside a directory containing `.env` with
`GITLAB_URL` (e.g. only `--gitlab-url` was passed). The tsup build bundles
`config.ts` into both dist entries (`index` and `internal`), creating two
separate axios instances per process: the CLI wired api access (baseURL /
token) through `internal`, while the commands issued requests through
`index` — which stayed unconfigured, so every request not going through
`internal` failed (`baseURL: undefined`). The instance is now a
process-wide singleton, so all bundles share one instance regardless of
entry point.
