# gitlab-analyzer

> **Mass-analyze GitLab repositories with a single command.** Search for strings (`console.log`, `debugger`, `TODO`, deprecated libraries) across every project reachable from your GitLab instance — in parallel, with filters and a ready-made report.

## Why

Instead of cloning dozens of repos and grepping them by hand, `gitlab-analyzer` does it for you:

- fetches the full project list via the GitLab API;
- downloads archives and searches for your strings (matches files containing **any** of them);
- writes a report (JSON or txt) tied to repos and files.

Result: hours saved on mass codebase searches.

## Installation

Requires **Node.js ≥ 22**.

```bash
# Global (CLI)
npm install -g @gitlab-analyzer/cli
# or
yarn global add @gitlab-analyzer/cli
```

After a global install the `gitlab-analyzer` binary is on your `PATH`.

### Run without installing — via `npx`

No global install needed. `npx` pulls the package on the fly:

```bash
npx @gitlab-analyzer/cli find-matches 'console.log' 'debugger'
```

For a stable version, pin it explicitly:

```bash
npx @gitlab-analyzer/cli@0.1.0 find-matches 'console.log'
```

> `npx` re-checks/downloads the package each run unless it's cached. For heavy, repeated use install globally once.

## Quick start

A `.env` is enough — no config file required.

1. Create `.env` in the directory where you run the command:

   ```ini
   GITLAB_URL=https://gitlab.example.com
   PRIVATE_TOKEN=YOUR_TOKEN
   ```

2. Run a search:

   ```bash
   gitlab-analyzer find-matches 'console.log' 'debugger'
   ```

Progress (`Processed 3 of 12 · my-frontend-app`) goes to **stderr**; the report goes to `find-matches-results-<date>.json`.

---

## `find-matches` — all options

```
gitlab-analyzer find-matches [options] <strings...>
```

| Option | Description | Default |
|---|---|---|
| `<strings...>` | One or more search strings. A file matches if it contains **ANY** of them (required) | — |
| `-r, --repo-filter <str>` | Substring filter for project names (passed to GitLab `search=`) | — |
| `-e, --exclude <list>` | Comma-separated repo names to skip | `[]` |
| `-b, --branch <name>` | Branch to scan in every project | `develop` |
| `--file-include <list>` | Comma-separated glob patterns; only files matching at least one pattern are scanned. A pattern without `/` matches by file name (basename) in any directory; with `/` — by full path | `[]` (scan all) |
| `--file-exclude <list>` | Comma-separated glob patterns; matching files are always skipped (wins over `--file-include`). Same basename/full-path rule as `--file-include` | `[]` |
| `--format <txt\|json>` | Report format (also drives the file extension) | `json` |
| `--stdout` | Also write the report to stdout (handy for piping) | off |
| `-o, --output <path>` | Where to write the report; omit for an auto-generated name | auto-name |
| `-c, --concurrency <n>` | Max parallel archive-fetch + zip-parse tasks | `5` |
| `--metrics-file <path>` | Write performance metrics (NDJSON: `run`/`repo`/`summary`) to a file. Diagnostic only — does not affect the report | — |
| `--interactive` | Pick repos manually before searching (all pre-selected; shows up to 50, ↑/↓ scrolls, space toggles, Enter confirms) | off |
| `--enable-logs` | Verbose debug/API logging (auto-enabled with `--interactive`) | off |
| `-h, --help` | Show help | — |

> Note: if `--format` conflicts with the extension of an explicit `--output` (e.g. `--format txt -o out.json`), the command fails with an error and writes nothing.

### Global flags

These are **top-level** flags (before the subcommand) — `gitlab-analyzer [global flags] find-matches ...`:

| Option | Description | Default |
|---|---|---|
| `--private-token <token>` | GitLab personal access token. Overrides `PRIVATE_TOKEN` env | env |
| `--gitlab-url <url>` | Base URL of the GitLab instance. Overrides `GITLAB_URL` env and `gitlab.url` config | env / config |

> **SECURITY:** passing a token via `--private-token` on the command line exposes it in shell history, the process list, and CI logs. Prefer `PRIVATE_TOKEN` env (or `.env`) as the primary way to supply the token; use the flag only when env is impractical.

### Examples

**Linux / macOS (bash/zsh):**

```bash
# Minimal run (requires .env)
gitlab-analyzer find-matches 'console.log' 'debugger'

# Token from an environment variable (no .env needed)
export PRIVATE_TOKEN="$MY_GITLAB_TOKEN"
export GITLAB_URL="https://gitlab.example.com"
gitlab-analyzer find-matches 'console.log'

# Or pass the env var straight into the flag for a single run
gitlab-analyzer find-matches 'console.log' \
  --private-token "$PRIVATE_TOKEN" \
  --gitlab-url "$GITLAB_URL"

# Frontend repos only, skipping archives, on your branch, report to a file
gitlab-analyzer find-matches 'TODO' 'FIXME' \
  --repo-filter 'frontend' \
  --exclude 'archived-repo,wip-repo' \
  --branch develop \
  -o ./results/find-matches.json

# Scan everything (all paths, including tests) to one file
gitlab-analyzer find-matches 'legacy-sdk' \
  --file-include '**/*' \
  --file-exclude 'dist/**,node_modules/**' \
  --format json -o results.json

# Report straight to stdout for jq (no file written)
gitlab-analyzer find-matches 'UPDATE' --stdout | jq '.metadata.branch'

# Interactive repo selection
gitlab-analyzer find-matches 'release-it' --interactive
# Without installing — via npx
npx @gitlab-analyzer/cli find-matches 'console.log' 'debugger'
```

**Windows (PowerShell):** line continuation uses a backtick (`` ` ``); set env vars via `$env:`.

```powershell
# Minimal run
gitlab-analyzer find-matches 'console.log' 'debugger'

# Full example — `` ` `` line breaks and a time-stamped file name
gitlab-analyzer find-matches 'TODO' 'FIXME' `
  --repo-filter 'frontend' `
  --exclude 'archived-repo,wip-repo' `
  --branch develop `
  -o "./results/run-$(Get-Date -Format 'yyyy-MM-dd-HHmm').json"

# Token set inline
$env:PRIVATE_TOKEN="YOUR_TOKEN"; gitlab-analyzer find-matches 'console.log'

# Token from an environment variable (no .env needed)
$env:PRIVATE_TOKEN=$env:MY_GITLAB_TOKEN
$env:GITLAB_URL="https://gitlab.example.com"
gitlab-analyzer find-matches 'console.log'

# Or pass the env var straight into the flag for a single run
gitlab-analyzer find-matches 'console.log' `
  --private-token $env:PRIVATE_TOKEN `
  --gitlab-url $env:GITLAB_URL

# To stdout, parsed with jq
gitlab-analyzer find-matches 'TODO' --stdout | jq '.repositories[].projectName'
```

**Windows (cmd):** line continuation uses `^`, env vars via `set`:

```bat
set PRIVATE_TOKEN=YOUR_TOKEN
gitlab-analyzer find-matches "console.log" "debugger" ^
  --repo-filter "frontend" ^
  --branch develop ^
  -o results.json

:: Token from an environment variable (no .env needed)
set PRIVATE_TOKEN=%MY_GITLAB_TOKEN%
set GITLAB_URL=https://gitlab.example.com
gitlab-analyzer find-matches "console.log"

:: Or pass the env var straight into the flag for a single run
gitlab-analyzer find-matches "console.log" --private-token %PRIVATE_TOKEN% --gitlab-url %GITLAB_URL%
```

---

## `list-repos` — preview the repo list

Prints the repositories that `find-matches` would scan with the same
repo-level filters — **without downloading archives or running a search**.
Use it to evaluate and tune `--repo-filter` / `--exclude` (and the config
`defaults.*`) before committing to a long scan.

```bash
gitlab-analyzer list-repos --repo-filter 'frontend' --exclude 'wip-repo'
```

| Option | Description | Default |
|---|---|---|
| `-r, --repo-filter <str>` | Substring filter for project names (passed to GitLab `search=`) | — |
| `-e, --exclude <list>` | Comma-separated repo names to skip | `[]` |

Plus the [global flags](#global-flags) (`--gitlab-url`, `--private-token`).

Behaviour:

- **Names go to stdout** — one per line, sorted alphabetically; progress and
  the final `Found N repositories matching the filters.` summary go to
  **stderr**, so the list is pipeable:

  ```bash
  gitlab-analyzer list-repos --repo-filter 'frontend' | wc -l
  ```

- **Only repo-level filters apply.** `--branch` and the file globs
  (`--file-include` / `--file-exclude`) act during the scan, not at list
  time — repos with a missing branch or fully-filtered-out files still
  appear here.
- **Empty result** — `No repositories found: filters/exclusions produced no
  results.` on stderr, exit code `0` (same semantics as the no-repos guard
  in `find-matches`).

---

## `fetch-files` — download files by name from many repos

Downloads every file matching the given name/glob patterns (e.g. all
`package-lock.json`) from all reachable repositories in a single run — so you
can analyze the collected files locally (jq, dependency search, scripts)
without downloading repo archives again and again.

```bash
gitlab-analyzer fetch-files [options] <patterns...>
```

| Option | Description | Default |
|---|---|---|
| `<patterns...>` | One or more glob patterns for file paths (see [Pattern matching](#pattern-matching)) (required) | — |
| `-r, --repo-filter <str>` | Substring filter for project names (passed to GitLab `search=`) | — |
| `-e, --exclude <list>` | Comma-separated repo names to skip | `[]` |
| `-b, --branch <name>` | Branch to fetch files from in every project | `develop` |
| `--file-exclude <list>` | Comma-separated glob patterns; matching files are always skipped (wins over the positional patterns). Same basename/full-path rule as the patterns | `[]` |
| `--format <json\|ndjson\|txt>` | Output layout — see [Formats](#formats) | `json` |
| `-o, --output <dir>` | Output **directory** (not a file path): results go into `<dir>/fetch-files-results-<timestamp>/` | cwd |
| `-c, --concurrency <n>` | Max parallel repositories (a repo's tree listing + all its file downloads share one slot) | `5` |
| `--interactive` | Pick repos manually before fetching (all pre-selected; shows up to 50, ↑/↓ scrolls, space toggles, Enter confirms) | off |
| `--enable-logs` | Verbose debug/API logging (auto-enabled with `--interactive`) | off |
| `--metrics-file <path>` | Write performance metrics (NDJSON: `run`/`repo`/`summary`) to a file. Diagnostic only — does not affect the results | — |
| `-h, --help` | Show help | — |

Plus the [global flags](#global-flags) (`--gitlab-url`, `--private-token`).
Tokens are read **only** from env vars / `.env` or the `--private-token` CLI
flag — never from config.

### Formats

Every run creates a **new timestamped directory** `fetch-files-results-<timestamp>/`
(in the current directory, or inside `-o <dir>` when given); previous runs are
never overwritten.

**`--format json` (default)** — one `<repo>.json` per repository with the file
contents embedded. `content` is `null` for binary or > 10 MB files; repos with
no matches (`not-found`) or an error get no JSON file:

```
fetch-files-results-<timestamp>/
├── meta.json
├── frontend-app.json      ← 2 matches inside (root + services/api)
└── backend-api.json       ← 1 match inside
```

**`--format ndjson`** — file-per-file mode: every matched file is written
**flat** into the results directory by its basename (`package-lock.json`);
name collisions get a suffix — `package-lock-1.json`, `package-lock-2.json`, …
— with a warning. `results.ndjson` is an **index only**: one line per file,
no content and no `webUrl` (correlate by `projectId` via meta.json):

```
{"projectId":42,"repo":"frontend-app","branch":"develop","path":"package-lock.json","bytes":214853,"savedAs":"package-lock.json"}
```

```
fetch-files-results-<timestamp>/
├── meta.json
├── results.ndjson
├── package-lock.json        ← from frontend-app (root)
├── package-lock-1.json      ← from frontend-app (services/api) — suffix
└── package-lock-2.json      ← from backend-api — suffix
```

**`--format txt`** — a human-readable dump with content, modeled on the
`find-matches` txt report: repo name → URL → `path: <path> (<bytes>)` → file
body; binary files get a placeholder line. Written into the same results
directory.

### meta.json

Written to the root of the results directory; two flat arrays, no content:

```json
{
  "generatedAt": "2026-08-28T14:30:05.412Z",
  "branch": "develop",
  "patterns": ["package-lock.json"],
  "format": "json",
  "repos": [
    { "projectId": 42, "projectName": "frontend-app",
      "webUrl": "https://gitlab.example.com/group/frontend-app",
      "branch": "develop", "status": "fetched", "branchExists": true,
      "filesTotal": 2, "filesFetched": 2, "filesFailed": 0, "error": null }
  ],
  "files": [
    { "projectId": 42, "repo": "frontend-app", "branch": "develop",
      "path": "package-lock.json", "bytes": 214853,
      "storage": "json", "savedAs": "frontend-app.json",
      "status": "fetched", "error": null }
  ]
}
```

- `repos[].status` — `fetched | not-found | partial | error` (unreachable
  repos and repos with a missing branch both end as `error`: a 404 on the
  tree listing does not distinguish the causes). `branchExists` is a
  heuristic: `true` only when the repo completed without an error.
- `files[].status` — `fetched | binary | failed | large`; `storage` —
  `json | file | ndjson` (or `null` for failed files); `savedAs` — the actual
  name of the written file, so every record traces to disk.

### Automatic behaviour (no flags)

- Files **≤ 10 MB** that are valid UTF-8 are embedded in the json/txt output.
- Files **> 10 MB** are streamed to disk instead (`content: null`, status
  `large`) with a warning; binary files are **always** saved as separate
  files with a warning (status `binary`).
- **429 (rate limit)** — up to 2 retries with exponential backoff (1s → 2s,
  honouring `Retry-After`); only 429s are retried, other errors fail
  immediately. Exhausted retries mark the repo `error`/`partial`.
- **Tree pagination** is capped at 100 pages (~10k entries) per repo with a
  loop guard; hitting the cap logs a warning and marks the repo `partial`.
- **Unsafe paths** (path traversal, Windows-reserved names, illegal
  characters) are **skipped, never renamed** — in **all** formats the
  skip-guard covers both embedded-mode refusals and the separate-file writes
  (binary/large) in `json`/`txt` modes, plus everything in `ndjson` mode: a
  warning is printed, the file gets `status: "failed"` in meta, and the repo
  may become `partial`.
- **Name collisions** (same basename from different repos/paths in `ndjson`
  mode; duplicate repo names in `json` mode) get a `-1`, `-2`… suffix until a
  free name is found + a warning; `savedAs` in meta always points to the
  actual file.
- Progress, warnings and the final `✓ Fetched N files (M repos), total X MB`
  summary (plus the path to `meta.json`) go to **stderr**.

### Pattern matching

Tree paths always start with `/` (e.g. `/src/foo.ts`), exactly like paths
inside archives in `find-matches`. A pattern **with a slash** matches the full
path (use `**/` to traverse directories); a pattern **without a slash** matches
by **file name (basename)** in any directory.

| Pattern | What it finds |
|---|---|
| `package-lock.json` | By basename in any directory (including the repo root) |
| `**/package-lock.json` | Same as above (explicit full-path form) |
| `*.ts` | Any `.ts` file by basename in any directory |
| `**/*.ts` | Any path ending in `.ts`, at any depth |
| `src/**/*.ts` | Does **NOT** match `/src/foo.ts` — tree paths carry a leading `/`; use `**/src/**/*.ts` |
| `**/src/**/*.ts` | Files only under a `src/` directory at any depth |
| `/src/foo.ts` | The exact path from the repo root |
| `**/*.test.*` | All test files |
| `**/node_modules/**/package-lock.json` | Only nested lock files (monorepo) |

### Examples

**Linux / macOS (bash/zsh):**

```bash
# Minimal run (requires .env)
gitlab-analyzer fetch-files 'package-lock.json'

# Token from an environment variable (no .env needed)
export PRIVATE_TOKEN="$MY_GITLAB_TOKEN"
export GITLAB_URL="https://gitlab.example.com"
gitlab-analyzer fetch-files 'package-lock.json' 'yarn.lock'

# Flat per-file layout with an NDJSON index
gitlab-analyzer fetch-files 'package-lock.json' --format ndjson

# Custom output directory, one JSON per repo
gitlab-analyzer fetch-files 'package-lock.json' -o ./out --format json
```

**Windows (PowerShell):** line continuation uses a backtick (`` ` ``); set env vars via `$env:`.

```powershell
# Minimal run
gitlab-analyzer fetch-files 'package-lock.json'

# Flat per-file layout with an NDJSON index
gitlab-analyzer fetch-files 'package-lock.json' --format ndjson

# Custom output directory + one JSON per repo
gitlab-analyzer fetch-files 'package-lock.json' `
  -o ./out `
  --format json

# Token from an environment variable (no .env needed)
$env:PRIVATE_TOKEN=$env:MY_GITLAB_TOKEN
$env:GITLAB_URL="https://gitlab.example.com"
gitlab-analyzer fetch-files 'package-lock.json'
```

**Windows (cmd):** line continuation uses `^`, env vars via `set`:

```bat
set PRIVATE_TOKEN=%MY_GITLAB_TOKEN%
set GITLAB_URL=https://gitlab.example.com
gitlab-analyzer fetch-files "package-lock.json"

gitlab-analyzer fetch-files "package-lock.json" --format ndjson

gitlab-analyzer fetch-files "package-lock.json" ^
  -o out ^
  --format json
```

#### Good to know

- **Zero matches is not an error** — a run where no file matches any pattern
  still writes `meta.json` (all repos `not-found`), prints a warning and
  exits `0`.
- **Every run creates a fresh timestamped directory** — nothing is ever
  overwritten, so run history is preserved.
- Collect the downloaded files from the index with jq:

  ```bash
  jq -r '"\(.repo)\t\(.path)\t\(.savedAs)"' fetch-files-results-*/results.ndjson
  ```

---

## Configuration (optional)

Option resolution precedence (highest wins):

```
1. CLI flag                  e.g. --branch main, --private-token, --gitlab-url
2. Environment variable      GITLAB_URL, PRIVATE_TOKEN (usually from .env)
3. gitlab-analyzer.json      defaults.*, commands.find-matches.*, gitlab.url
4. Built-in default          branch="develop", concurrency=5, fileInclude=[], fileExclude=[]
```

A config is useful for **persistent, non-secret** values (branch, exclusions, concurrency, output path). **Never** put tokens in a config — env only (or the `--private-token` CLI flag).

```json
{
  "gitlab": { "url": "https://gitlab.example.com" },
  "defaults": {
    "branch": "develop",
    "repoNameFilter": "frontend",
    "excludeRepos": ["archived-repo", "wip-repo"],
    "fileInclude": [],
    "fileExclude": []
  },
  "commands": {
    "find-matches": {
      "concurrency": 5,
      "output": "./results/find-matches.json"
    }
  }
}
```

| Field | Default | Purpose |
|---|---|---|
| `gitlab.url` | — | GitLab instance URL (alternative to `GITLAB_URL`) |
| `defaults.branch` | `"develop"` | Branch to scan |
| `defaults.repoNameFilter` | — | Substring filter for repo names |
| `defaults.excludeRepos` | `[]` | Repos to skip |
| `defaults.fileInclude` | `[]` | Glob patterns; only matching files are scanned |
| `defaults.fileExclude` | `[]` | Glob patterns; matching files are always skipped (wins over `fileInclude`) |
| `defaults.enableLogs` | `false` | Enable debug logging |
| `commands.find-matches.concurrency` | `5` | Parallel requests |
| `commands.find-matches.output` | — | Report path |

## Logging

Log lines go to **stderr** (stdout stays clean and pipeable) and are divided
into **levels**, each with its own symbol and color:

| Level | Symbol / color | Visible | Typical use |
|---|---|---|---|
| `debug` | `[debug]` gray | only with `--enable-logs` | per-file detail: archive download, unzip steps |
| `info` | `ℹ` cyan | always | phase boundaries: "Fetching repository list…", "Starting search…" |
| `success` | `✓` green | always | completions: "Done: repo", "Search finished.", final summary |
| `warn` | `⚠` yellow | always | recoverable problems: "Archive not fetched", "repo bloated" |
| `error` | `✗` red | always | fatal CLI errors |

`--enable-logs` (or `--interactive`) still turns on the full `[debug]` trace;
`info`/`success`/`warn` are shown regardless for a readable default run. Blank
lines separate the phases (list → search → summary), and the run ends with a
summary block: `✓ Scanned repositories: N`, an optional `⚠ Of which errored:
K (repos…)` line, and `✓ Report: path`. Durations use a latin `s`
(`0.3s`). Colors respect `NO_COLOR` and auto-detect a TTY; there is no
`--no-color` flag (set `NO_COLOR=1` instead).

If no repositories match the filters (`--repo-filter` / `--exclude`), the run
stops early with `ℹ No repositories found: filters/exclusions produced no
results.` and exits `0` — it does not start a meaningless zero-repo
search or print an empty summary.

## Exporting results

- **`--output <path>`** — write the report to the given file.
- **Without `--output`** — auto-name `find-matches-results-<date>.json` (or `.txt` with `--format txt`); a numeric suffix `-1`, `-2`… is appended if the name is taken.
- **`--stdout`** — additionally write the report to stdout (for piping).
- Progress and errors always go to **stderr**, so stdout stays clean.

```bash
gitlab-analyzer find-matches 'TODO' --stdout | jq '.repositories[].projectName'
```

## Performance metrics

Every run prints a compact `Metrics:` summary line to **stderr** right after the
`✓ Scanned…` block — run-level aggregates only, so the normal run stays
uncluttered:

```
Metrics: 12 repos · list 1.2s (3 pg, 12 repos) · total 34.5s · avg 2.8s · max my-frontend-app (8.1s) · heap Δ+23.4 MB
```

`heap Δ` is the run-scope heap-growth (`heapUsed` after − before the search); it
may be negative if a GC ran between the two samples.

For per-repo detail (download/unzip/scan timings, file counts, matched/errored
repos) pass `--metrics-file <path>`. It writes **NDJSON** — one JSON object per
line, three record kinds:

```jsonl
{"t":"run","exitReason":"complete","listMs":1234,"pagesFetched":3,"reposFound":12,"totalWallMs":34500,"totalPerRepoMs":33899,"startedAt":"...","finishedAt":"..."}
{"t":"repo","projectId":42,"projectName":"my-frontend-app","downloadMs":4100,"unzipMs":2500,"scanMs":1450,"totalMs":8100,"filesScanned":340,"filesMatched":12,"textLength":125000,"error":null}
{"t":"summary","exitReason":"complete","repos":12,"ok":11,"errored":1,"totalWallMs":34500,"totalPerRepoMs":33899,"avgRepoMs":2825,"maxRepoMs":8100,"maxRepoName":"my-frontend-app","totalHeapGrowthBytes":24536600}
```

- `t: "run"` — whole-run list + wall-clock metrics (`exitReason` is
  `complete` | `cancel` | `no-repos`).
- `t: "repo"` — one per processed repo (`error` is `null` on success, else the
  message; for a failed repo `downloadMs` ≈ the timeout spent).
- `t: "summary"` — always the **last** line; run-level aggregates.

Metrics are diagnostics: they never change the report itself, and `--metrics-file`
is a CLI-only flag (never read from config or env). A failure to write the metrics
file is a warning on stderr, never a fatal error — the report is already written.

## Good to know

- **No matches but the string is definitely there?** The default scan includes every file. Narrow it down with `--file-include '**/src/**'` (or whatever path you care about); widen it explicitly only if you've set a default in your config that excludes too much.
- **Tests are scanned by default** — exclude them with `--file-exclude '**/*.test.ts'`.

### Common glob patterns

Paths inside the archive always start with `/` (e.g. `/src/foo.ts`).

A pattern **with a slash** matches the full path — so it must account for that
leading slash (use `**/` to traverse directories). A pattern **without a slash**
matches by **file name (basename)** in any directory.

| Need | Pattern |
|---|---|
| Find test files | `**/*.test.*` |
| Find a file by its exact name (anywhere) | `foo.ts` or `**/foo.ts` |
| Find any `.ts` file | `*.ts` or `**/*.ts` |
| Find files only under `src/` | `**/src/**/*.ts` |
| Skip node_modules | `**/node_modules/**` |
- **Too many requests on a big instance?** Lower `--concurrency 2`.
- **401 Unauthorized** — check `PRIVATE_TOKEN` (needs `read_api` scope).
- Tokens are read **only** from env vars / `.env` or the `--private-token` CLI flag — never from config.

## CLI help

```bash
gitlab-analyzer --help
gitlab-analyzer find-matches --help
```

## License

MIT.
