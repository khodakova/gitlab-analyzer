---
'@gitlab-analyzer/core': minor
---

Add opt-in debug/API logging via `--enable-logs` (and `ENABLE_LOGS` env /
`defaults.enableLogs` config). Logs are off by default; errors are always
logged to stderr, and `--interactive` enables the full log automatically.
Exposes `configureLogger` / `logger` in the library API.

Also:
- Suppress dotenv's "injected env" console chatter (`quiet: true`).
- Add `projects` option to `findMatches` so a caller that already loaded the
  project list can avoid a duplicate GitLab project fetch (and duplicate
  "Найдено репозиториев" log line). The CLI now passes its pre-filtered list.
