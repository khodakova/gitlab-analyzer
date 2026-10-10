# gitlab-analyzer

Mass-analyze GitLab repositories with a single command — instead of cloning
dozens of repos and grepping them by hand.

## What it does

- **`find-matches`** — search file contents for specific strings across every
  project on a GitLab instance (matches files containing ANY of the strings).
- **`fetch-files`** — download every file matching glob patterns (all
  `package-lock.json`, all `*.env`, …) from many repos in one run.
- **`get-last-commits`** — report the last commit per repository: the branch
  tip, or the last commit touching each file matched by a glob.
- **`list-repos`** — preview which repositories match your filters before a
  long scan.

Runs in parallel, with repo-level filters (`-r`, `-e`, `--interactive`) and a
self-describing report (JSON or txt) per run.

## Install

Requires Node.js ≥ 22.12.

```bash
npm install -g @gitlab-analyzer/cli
# or run without installing:
npx @gitlab-analyzer/cli find-matches 'TODO'
```

## Quick start

Create a `.env` in the directory where you run the command:

```ini
GITLAB_URL=https://gitlab.example.com
PRIVATE_TOKEN=YOUR_TOKEN
```

Then:

```bash
gitlab-analyzer find-matches 'console.log' 'debugger'
```

Progress goes to stderr; the report lands in
`find-matches-results-<date>.json`. Every command writes a JSON/txt report
you can pipe with `--stdout` and jq.

## Documentation

- **Commands, flags, examples** — [packages/cli/README.md](packages/cli/README.md)
- **Library API** (`findMatches`, `fetchFiles`, `getLastCommits`) —
  [packages/core/README.md](packages/core/README.md)
