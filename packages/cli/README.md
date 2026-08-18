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
npm install -g gitlab-analyzer
# or
yarn global add gitlab-analyzer
```

After a global install the `gitlab-analyzer` binary is on your `PATH`.

### Run without installing — via `npx`

No global install needed. `npx` pulls the package on the fly:

```bash
npx gitlab-analyzer find-matches 'console.log' 'debugger'
```

For a stable version, pin it explicitly:

```bash
npx gitlab-analyzer@0.1.0 find-matches 'console.log'
```

> `npx` re-checks/downloads the package each run unless it's cached. For heavy, repeated use install globally once.

## Quick start

A `.env` is enough — no config file required.

1. Create `.env` in the directory where you run the command:

   ```ini
   GITLAB_URL=https://gitlab.example.com
   PRIVATE_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx
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
| `--file-include <list>` | Comma-separated glob patterns; only files matching at least one pattern are scanned | `[]` (scan all) |
| `--file-exclude <list>` | Comma-separated glob patterns; matching files are always skipped (wins over `--file-include`) | `[]` |
| `--format <txt\|json>` | Report format (also drives the file extension) | `json` |
| `--stdout` | Also write the report to stdout (handy for piping) | off |
| `-o, --output <path>` | Where to write the report; omit for an auto-generated name | auto-name |
| `-c, --concurrency <n>` | Max parallel archive-fetch + zip-parse tasks | `5` |
| `--metrics-file <path>` | Write performance metrics (NDJSON: `run`/`repo`/`summary`) to a file. Diagnostic only — does not affect the report | — |
| `--interactive` | Pick repos manually before searching (all pre-selected; shows up to 50, ↑/↓ scrolls, space toggles, Enter confirms) | off |
| `--enable-logs` | Verbose debug/API logging (auto-enabled with `--interactive`) | off |
| `-h, --help` | Show help | — |

> Note: if `--format` conflicts with the extension of an explicit `--output` (e.g. `--format txt -o out.json`), the command fails with an error and writes nothing.

### Examples

**Linux / macOS (bash/zsh):**

```bash
# Minimal run (requires .env)
gitlab-analyzer find-matches 'console.log' 'debugger'

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
npx gitlab-analyzer find-matches 'console.log' 'debugger'
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
$env:PRIVATE_TOKEN="glpat-xxxx"; gitlab-analyzer find-matches 'console.log'

# To stdout, parsed with jq
gitlab-analyzer find-matches 'TODO' --stdout | jq '.repositories[].projectName'
```

**Windows (cmd):** line continuation uses `^`, env vars via `set`:

```bat
set PRIVATE_TOKEN=glpat-xxxx
gitlab-analyzer find-matches "console.log" "debugger" ^
  --repo-filter "frontend" ^
  --branch develop ^
  -o results.json
```

---

## Configuration (optional)

Option resolution precedence (highest wins):

```
1. CLI flag                  e.g. --branch main
2. Environment variable      GITLAB_URL, PRIVATE_TOKEN (usually from .env)
3. gitlab-analyzer.json      defaults.*, commands.find-matches.*, gitlab.url
4. Built-in default          branch="develop", concurrency=5, fileInclude=[], fileExclude=[]
```

A config is useful for **persistent, non-secret** values (branch, exclusions, concurrency, output path). **Never** put tokens in a config — env only.

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
| `info` | `ℹ` cyan | always | phase boundaries: "Получение списка…", "Начинаю поиск…" |
| `success` | `✓` green | always | completions: "Готово: repo", "Поиск завершён.", final summary |
| `warn` | `⚠` yellow | always | recoverable problems: "Архив не получен", "репо раздуто" |
| `error` | `✗` red | always | fatal CLI errors |

`--enable-logs` (or `--interactive`) still turns on the full `[debug]` trace;
`info`/`success`/`warn` are shown regardless for a readable default run. Blank
lines separate the phases (list → search → summary), and the run ends with a
summary block: `✓ Отсканировано репозиториев: N`, an optional `⚠ Из них с
ошибкой: K (repos…)` line, and `✓ Отчёт: path`. Durations use a latin `s`
(`0.3s`). Colors respect `NO_COLOR` and auto-detect a TTY; there is no
`--no-color` flag (set `NO_COLOR=1` instead).

If no repositories match the filters (`--repo-filter` / `--exclude`), the run
stops early with `ℹ Репозитории не найдены: фильтр/исключения не дали
результатов.` and exits `0` — it does not start a meaningless zero-repo
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
`✓ Отсканировано…` block — run-level aggregates only, so the normal run stays
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

Paths inside the archive always start with `/` (e.g. `/src/foo.ts`), so patterns must account for that leading slash.

| Need | Pattern |
|---|---|
| Find test files | `**/*.test.*` |
| Find a file by its exact name (anywhere) | `**/foo.ts` |
| Find any `.ts` file | `**/*.ts` |
| Find files only under `src/` | `**/src/**/*.ts` |
| Skip node_modules | `**/node_modules/**` |
- **Too many requests on a big instance?** Lower `--concurrency 2`.
- **401 Unauthorized** — check `PRIVATE_TOKEN` (needs `read_api` scope).
- Tokens are read **only** from env vars / `.env` — never from config.

## CLI help

```bash
gitlab-analyzer --help
gitlab-analyzer find-matches --help
```

## License

MIT.
