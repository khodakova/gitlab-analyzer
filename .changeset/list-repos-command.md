---
'gitlab-analyzer': minor
---

Add a `list-repos` CLI command: prints the repositories that `find-matches`
would scan with the same repo-level filters (`--repo-filter`, `--exclude`,
config `defaults.repoNameFilter` / `defaults.excludeRepos`) — without
downloading archives or running a search. Names go to stdout (one per line,
sorted) so the list is pipeable; progress and the count summary go to stderr.
Empty result prints a message to stderr and exits 0. Note: `--branch` and the
file globs do not affect this list — they act during the scan, not at
list time.
