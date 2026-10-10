---
'gitlab-analyzer': minor
---

New `get-last-commits` command: report the last commit for every selected
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
