---
'gitlab-analyzer': patch
'@gitlab-analyzer/core': minor
---

Add search performance metrics. Core exposes a new `onRepoTiming(timing)`
option on `findMatches` (per-repo download/unzip/scan timings plus aggregated
file counters, fired for success and failure) and optional mutable `metrics?`
accumulators on `getProjectArchive`/`findStrInZip`/`getAllProjects` (re-exported
from `@gitlab-analyzer/core/internal`, not the public API). The CLI prints a
compact run-level `Metrics:` summary to stderr and, with `--metrics-file
<path>`, writes machine-readable NDJSON (`run`/`repo`/`summary` records) —
diagnostic output that never changes the report. Heap growth is sampled once
per run (`totalHeapGrowthBytes`, may be negative).
