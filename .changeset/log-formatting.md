---
'gitlab-analyzer': patch
'@gitlab-analyzer/core': minor
---

Improve CLI log output: add log levels (info/success/warn), debug `[debug]`
prefixes, symbols (✓/⚠/ℹ/✗), colors (NO_COLOR-aware), a write mutex, blank
lines between phases, and a final summary block; use latin `s` for durations.
Core adds new public API: logger.info/success/warn, flushLogs(), formatDuration().
