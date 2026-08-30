# gitlab-analyzer

> CLI + library for mass analysis of GitLab repositories — search for specific
> strings across every project reachable from your GitLab instance.

## Features

- **`gitlab-analyzer find-matches <strings...>`** — find one or more substrings
  across every project in a GitLab instance, with filters for repo name,
  branch, and glob-based file include/exclude.
- **`gitlab-analyzer fetch-files <patterns...>`** — download every file
  matching the given glob patterns from all reachable projects: text files
  are embedded as UTF-8 in the report, binary and oversized files are handed
  to a `saveFile` hook for streaming. See the
  [CLI package README](../cli/README.md) for the full flag reference.
- **Programmatic API** — `import { findMatches, fetchFiles, loadConfig } from 'gitlab-analyzer'`
  for custom post-processing pipelines.
- **Config-driven** — JSON / JS / TS config files via
  [cosmiconfig](https://github.com/davidtheclark/cosmiconfig), validated against
  a [zod](https://zod.dev) schema.
- **Parallel by default** — controlled concurrency via
  [`p-limit`](https://github.com/sindresorhus/p-limit), default 5 parallel
  archive fetches.
- **Self-describing report output** — results are written as a JSON object
  (or human-readable `txt`) with `metadata` (when, which branch, which repos,
  which strings, filters) plus a per-repo breakdown that includes any fetch
  errors. Output goes to a file (auto-named or `--output`) and optionally to
  stdout (`--stdout`).

## Installation

```bash
# Global (recommended for the CLI)
yarn global add gitlab-analyzer

# Local to a project (when consuming the library API)
yarn add gitlab-analyzer
```

After a global install, the `gitlab-analyzer` binary is on your `PATH`.

> Requires **Node.js ≥ 20**.

## Quick Start

The minimum to run `find-matches` is a working `.env` with your GitLab URL
and a private token — **no config file is required**. The CLI checks CLI
flags, then environment variables, then `gitlab-analyzer.json`, then
built-in defaults. If anything required is still missing after all that,
the CLI prints one consolidated error listing every missing field.

1. **Create `.env`** in the directory where you'll run the binary (it's
   already in `.gitignore`):

   ```ini
   # .env
   GITLAB_URL=https://gitlab.example.com
   PRIVATE_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx
   ```

2. **Run a search**:

   ```bash
   gitlab-analyzer find-matches 'console.log' 'debugger' \
     --branch develop \
     --output ./results.json
   ```

   Progress (`Processed 3 of 12 · my-frontend-app`) goes to **stderr**; the JSON array of
   matches goes to `./results.json`.

> A `gitlab-analyzer.json` config file is **optional**. Use it when you want
> to set persistent defaults (branch, excludeRepos, concurrency, output
> path) without typing them on every command. See [Configuration](#configuration)
> for the precedence chain and field reference.

## Configuration

`gitlab-analyzer` resolves every option through a single precedence chain.
The CLI does not require any config file to be present — a working `.env`
is enough. A `gitlab-analyzer.json` is only needed when you want persistent
defaults (branch, excludeRepos, concurrency, output path) across commands.

### Precedence

Each option is resolved in this order (highest wins):

```
1. CLI flag                        e.g. --branch main
2. Environment variable            GITLAB_URL, PRIVATE_TOKEN (typically from .env)
3. gitlab-analyzer.json config     defaults.*, commands.find-matches.*, gitlab.url
4. Built-in default                branch="develop", concurrency=5, fileInclude=[], fileExclude=[], ...
```

If, after all four sources are consulted, a **required** option is still
missing, the CLI exits with **one** error that lists every missing field
along with guidance on how to satisfy it. Required fields are:

- `gitlab.url` — from `GITLAB_URL` env or `gitlab.url` in config
- `PRIVATE_TOKEN` — from env only (never config — see [Security](#security-tokens))
- At least one positional search string

### Optional config file

A config file is the right place for **non-secret defaults** you want to
reuse across invocations: default branch, repo exclusion list, output path,
concurrency, etc. Tokens never belong in a config file.

If you DO want one, `gitlab-analyzer` reads it from JSON / JS / TS files via
[cosmiconfig](https://github.com/davidtheclark/cosmiconfig). Files are
looked up in two layers (project and user-home), merged with built-in
defaults, and validated against a [zod](https://zod.dev) schema.

#### Search locations

Two layers are searched, in this order (first match wins):

**Project layer** — `process.cwd()` and each parent directory up to the
filesystem root, looking for any of:

- `gitlab-analyzer.json`
- `gitlab-analyzer.config.json`
- `gitlab-analyzer.config.js`
- `gitlab-analyzer.config.mjs`
- `gitlab-analyzer.config.cjs`
- `gitlab-analyzer.config.ts`
- `gitlab-analyzer` key inside `package.json`

**User-home layer** — `~/.config/gitlab-analyzer/`, looking for any of:

- `config.json`
- `config.yaml` / `config.yml`
- `config.js` / `config.cjs` / `config.mjs`
- `config.ts`

When no file is found in either layer, `loadConfig()` simply returns a
fully defaulted object — `gitlab` is undefined, the CLI then surfaces the
specific missing fields via its consolidated error.

### Minimal example

When you DO use a config file, the smallest meaningful one contains only
your GitLab URL. Everything else falls back to defaults:

```json
{
  "gitlab": {
    "url": "https://gitlab.example.com"
  }
}
```

A more complete example showing every supported field:

```json
{
  "gitlab": {
    "url": "https://gitlab.example.com"
  },
  "defaults": {
    "branch": "develop",
    "repoNameFilter": "frontend",
    "excludeRepos": ["archived-repo", "wip-repo"],
    "fileInclude": [],
    "fileExclude": [],
    "enableLogs": true
  },
  "commands": {
    "find-matches": {
      "concurrency": 5,
      "output": "./find-matches-result.json"
    }
  }
}
```

### Field reference

| Field | Type | Default | Purpose |
|---|---|---|---|
| `gitlab.url` | string (URL) | — | Base URL of your GitLab instance. Optional in config — `GITLAB_URL` env (or `.env`) also works. |
| `defaults.branch` | string | `"develop"` | Branch to scan |
| `defaults.repoNameFilter` | string | — | Substring filter for repo names |
| `defaults.excludeRepos` | string[] | `[]` | Repo names to skip |
| `defaults.fileInclude` | string[] | `[]` | Glob patterns; only matching files are scanned |
| `defaults.fileExclude` | string[] | `[]` | Glob patterns; matching files are always skipped (wins over `fileInclude`) |
| `defaults.enableLogs` | boolean | `false` | Enable debug/API logging (see [Logging](#logging)) |
| `commands.find-matches.concurrency` | int (positive) | `5` | Parallel requests to GitLab |
| `commands.find-matches.output` | string | — | Path to write JSON results |

## CLI Usage

The package ships one command today: `find-matches`. Run
`gitlab-analyzer --help` to list commands and `gitlab-analyzer find-matches
--help` for the full option reference.

### `find-matches` — option reference

```
gitlab-analyzer find-matches [options] <strings...>

Search for specific strings across all GitLab projects reachable from the
configured instance

Arguments:
  strings                  One or more search substrings; a file matches if it
                           contains ANY of them

Options:
  -r, --repo-filter <str>  Substring filter for project names (passed to GitLab search=)
  -e, --exclude <list>     Comma-separated list of repo names to skip
  -b, --branch <name>      Branch to scan in every project
    --file-include <list> Comma-separated glob patterns; only files matching at
                           least one pattern are scanned (default: all)
    --file-exclude <list> Comma-separated glob patterns; matching files are
                           always skipped (wins over --file-include)
      --format <txt|json>  Report format (default: json; drives the extension of
                           the auto-generated file name)
      --stdout             Also write the report to stdout (in addition to the file)
  -o, --output <path>      Path to write the report; omit to use an auto-generated
                           file name
  -c, --concurrency <n>    Maximum number of parallel archive-fetch + zip-parse tasks
      --interactive        Let you choose which repositories to search
                           (space toggles a repo, Enter confirms); empty
                           selection cancels the run
      --enable-logs        Enable debug/API logging (also enabled automatically
                           with --interactive)
  -h, --help               display help for command
```

### Interactive repo selection

By default `find-matches` searches every reachable project (after
`excludeRepos`/`--exclude`). Pass `--interactive` to pick the repos yourself
before the search runs:

```bash
gitlab-analyzer find-matches 'TODO' --interactive
```

An `enquirer` multi-select list shows every repo initially selected. Use
**space** to toggle a repo, **arrows** to move, **Enter** to confirm. The
search then runs only against the repos you left selected. If you deselect
every repo and confirm, the run is cancelled (message on stderr, exit code 0,
no search). In non-interactive (default) mode the resolved repo list is printed
to stderr before searching so you can see where the search will run.

### Logging

By default the tool is quiet (`--enable-logs` is **off**): progress
(`Processed 3 of 12 · repo`), the summary line, and the pre-search repo list are always
printed to **stderr**, but debug/API output is suppressed.

Pass `--enable-logs` to turn on the full debug log: API request URLs,
"Repositories found: N", per-project recovery messages (e.g. an archive
that could not be fetched — the repo is skipped and the scan continues), and
other informational steps. `--interactive` also enables the full log
automatically (interactive mode needs it), so you don't have to pass
`--enable-logs` separately.

**Errors are always logged** to stderr regardless of the flag — a missing
token/config, a failed project-list fetch, or any fatal error is never
silently swallowed.

The flag resolves through the standard precedence chain
(CLI → env → config → default):

- **CLI:** `--enable-logs`
- **Env:** `ENABLE_LOGS=true` (truthy values: `1`, `true`, `yes`, `on`)
- **Config:** `defaults.enableLogs`
- **Default:** `false`

```bash
# Debug logging on for one run:
gitlab-analyzer find-matches 'TODO' --enable-logs

# Equivalent via env var:
ENABLE_LOGS=true gitlab-analyzer find-matches 'TODO'
```

All log output goes to **stderr**, so the JSON result on stdout stays clean
and pipeable.

### Example invocation

```bash
PRIVATE_TOKEN=<your-private-token> \
  gitlab-analyzer find-matches 'console.log' 'debugger' \
    --repo-filter 'frontend' \
    --exclude 'archived-repo,wip-repo' \
    --branch develop \
    --output ./results/find-matches.json
```

### Multi-line invocations (PowerShell)

For longer commands, PowerShell continues a line with a backtick (`` ` ``)
at the end of each line. The `>>` prefix is PowerShell's continuation
prompt — type the backtick, press Enter, and keep typing. The output
filename uses `$(Get-Date -Format ...)` so each run lands in its own
file and nothing gets overwritten:

```powershell
node dist/cli.js find-matches 'string1', 'string2' `
  --repo-filter 'my-repo' `
  --file-include '**/*.ts,**/*.tsx' `
  -o "./results/run-$(Get-Date -Format 'yyyy-MM-dd-HHmm').json"
```

### Output routing

- **`--output <path>`** (or `commands.find-matches.output` in the config)
  writes the report to the given file.
- **No `--output` flag and no config default** — an auto-named file is
  created in the current directory: `find-matches-results-<DATE>.<ext>`,
  where `<ext>` is `.json` (default) or `.txt` (with `--format txt`). If a
  file with that name already exists, a numeric version is appended before
  the extension (`-1`, `-2`, …) until a free name is found.
- **`--stdout`** — additionally write the report to **stdout** (useful for
  piping; with `--output` the report goes both to the file and to stdout).
- **`--format <txt|json>`** — chooses the report format (default `json`).
  If `--format` conflicts with the extension of an explicit `--output` path
  (e.g. `--format txt -o result.json`), the command fails with an error and
  nothing is written.
- **Progress** (e.g. `Processed 3 of 12 · my-frontend-app`) and **error / summary lines**
  always go to **stderr**, so the report on stdout stays clean for piping:

  ```bash
  gitlab-analyzer find-matches 'TODO' --stdout | jq '.metadata.branch'
  gitlab-analyzer find-matches 'TODO' --stdout | jq '.repositories[].projectName'
  ```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success — output written (file or stdout). |
| 1 | Runtime error — failed to load config, GitLab API failure, I/O error. |
| 2 | Invalid CLI usage — commander-detected (unknown flag, missing argument). |

The error message is written to stderr before exit.

## Programmatic API

For custom post-processing, import the library functions directly:

```ts
import {
  findMatches,
  loadConfig,
  configureLogger,
  type FindMatchesOptions,
  type MatchResult,
} from 'gitlab-analyzer';

const config = await loadConfig();

// Optional: turn on debug/API logging for library calls.
configureLogger({ enabled: true });

const results: MatchResult[] = await findMatches({
  searchStrings: ['console.log', 'debugger'],
  branch: config.defaults.branch,
  repoNameFilter: 'frontend',
  excludeRepos: ['archived-repo'],
  selectedRepos: [
    { id: 42, name: 'frontend-app' },
    { id: 7, name: 'backend-api' },
  ],
  fileInclude: [],
  fileExclude: [],
  concurrency: 5,
  onProgress: (done, total, currentRepo) => {
    process.stderr.write(`[${done}/${total}] ${currentRepo}\n`);
  },
});

// Custom post-processing — that's why the library surface exists
const summary = results
  .filter((r) => r.results.length > 0)
  .map((r) => ({
    repo: r.projectName,
    matchCount: r.results.reduce((acc, x) => acc + x.matches.length, 0),
  }))
  .sort((a, b) => b.matchCount - a.matchCount);

await fs.writeFile('my-custom-report.json', JSON.stringify(summary, null, 2));
```

`findMatches` never writes files and never calls `process.exit` — it is an
async function returning the result array. It does, however, write diagnostic
lines to **stderr** through the shared central logger: `debug` lines are
gated by `configureLogger({ enabled })` (off by default), while
`info`/`success`/`warn`/`error` lines always print. For a completely silent
library run, call `configureLogger({ enabled: false })` (see "Logging"
below). All output / progress / process management is the caller's
responsibility when using the library API directly.

The library also exports a small central logger — `configureLogger({ enabled })`
and `logger` (`logger.debug(...)`, `logger.info(...)`, `logger.success(...)`,
`logger.warn(...)`, `logger.error(...)`), plus `flushLogs()` and
`formatDuration()`. It mirrors the CLI's behavior: `debug` lines are silent
unless enabled (default off), while `info`/`success`/`warn`/`error` always
print, and everything goes to **stderr**. Each line is formatted with a level
symbol and color (`[debug]` gray, `ℹ` cyan, `✓` green, `⚠` yellow, `✗` red),
respecting `NO_COLOR`. Writes are queued so lines never interleave, even under
concurrency. Call `flushLogs()` before `process.exit` to drain the queue.
Enable it when you want the internal API/utils output for your own
programmatic runs.

`findMatches` accepts an optional `projects` array of already-fetched
`SearchProjectsItem` objects. When provided, it skips the project-list fetch
(so `getAllProjects` is not called again) and just runs the search over that
list — useful when a caller has already loaded the repos (e.g. a CLI that built
the picker). `excludeRepos` / `selectedRepos` are still applied on top.

### Performance metrics (`onRepoTiming`)

For diagnosing where time goes, `findMatches` accepts an optional
`onRepoTiming(timing)` callback that fires once per processed repository (both
success **and** failure) with per-repo performance data — download/unzip/scan
durations, `totalMs`, and aggregated per-file counters (`filesScanned`,
`filesMatched`, `textLength`), plus `error` for a repo whose archive could not
be fetched:

```ts
await findMatches({
  searchStrings: ['console.log'],
  branch: 'develop',
  onRepoTiming: (t) => {
    // t = { projectId, projectName, downloadMs, unzipMs, scanMs, totalMs,
    //       filesScanned, filesMatched, textLength, error? }
  },
});
```

This is a separate channel from the returned `MatchResult[]` — the result and
report shapes are unchanged. Heap usage is sampled per run (not per repo); the
CLI surfaces it via `--metrics-file`. The first-class API to get metrics is
`onRepoTiming`; `findMatches` also accepts an optional internal `metrics`
accumulator (typed as `SearchMetrics`, from `@gitlab-analyzer/core/internal`)
that collects the same data plus list metrics in one place for CLI-style tools.

### `fetchFiles()`

`fetchFiles` walks the same repo set as `findMatches` (same filters:
`repoNameFilter`, `excludeRepos`, `selectedRepos`, `projects`, `fileExclude`,
same `concurrency` default of 5 — per repo, not per file) and downloads every
file matching the glob `patterns` on the given `branch`. Instead of searching
content it returns the files themselves, so the persistence decision belongs
to you via the `saveFile` hook:

```ts
import { writeFile, mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import {
  fetchFiles,
  loadConfig,
  type SaveFileInput,
} from 'gitlab-analyzer';

const config = await loadConfig();

const result = await fetchFiles({
  patterns: ['**/*.env', '**/*.yml'],
  branch: config.defaults.branch,
  repoNameFilter: 'frontend',
  fileExclude: ['**/node_modules/**'],
  saveFile: async (input: SaveFileInput) => {
    const dir = `./fetched/${input.repo}`;
    await mkdir(dir, { recursive: true });
    const dest = `${dir}/${input.path.replace(/\//g, '__')}`;
    if (input.data instanceof Buffer) {
      await writeFile(dest, input.data);
    } else {
      await pipeline(input.data, createWriteStream(dest));
    }
    return { savedAs: dest };
  },
  onProgress: (done, total, currentRepo, error) => {
    process.stderr.write(`[${done}/${total}] ${currentRepo}${error ? ` (${error})` : ''}\n`);
  },
});

// Custom post-processing — every file of every repo is in the result
for (const repo of result.repos) {
  if (repo.status === 'error') continue;
  const embedded = repo.files.filter((f) => f.status === 'fetched');
  console.log(repo.projectName, embedded.map((f) => f.path));
}
```

Key contract points:

- **No disk writes without `saveFile`.** `fetchFiles` itself never writes
  files and never calls `process.exit` — the `saveFile` hook is the only
  write path. Core decides **what** each file is (`status` plus a `Buffer`
  or a `Readable` in `data`); the hook decides **where** (naming, path
  safety, collision handling). Files with status `failed` never reach the
  hook. The `savedAs` you return (or `null`) is written back into the
  matching `FetchedFile`.
- **`MAX_EMBED_BYTES` (10 MB).** Files at or below 10 MB are buffered and
  passed to `saveFile` as a `Buffer` — as UTF-8-validated `content` with
  status `fetched`, or as status `binary` (non-UTF-8) with `content: null`.
  Files above 10 MB get status `large` and `data` is a not-yet-consumed
  stream positioned at byte 0 — pipe it somewhere or it is lost (`bytes`
  is `null` there, since the size is only known after consuming the
  stream).
- **Return shape.** `{ repos: FetchedRepo[] }` — one entry per repo with
  `status` (`fetched` / `not-found` / `partial` / `error`), counters
  (`filesTotal` / `filesFetched` / `filesFailed`), `truncated`, `error`,
  and a `files` array where every processed file lands with its own
  `status` (`fetched` / `binary` / `failed` / `large`), `content` (embedded
  text only), `savedAs` and `error`. Unlike the CLI report, the library
  result has no `branchExists` field — the CLI derives it from `error`.
- All types (`FetchFilesOptions`, `FetchFilesResult`, `FetchedRepo`,
  `FetchedFile`, `FetchedFileStatus`, `RepoStatus`, `SaveFileInput`,
  `SaveFileResult`) are exported from `gitlab-analyzer`.

## Output Schema

### Library API (`findMatches`)

`findMatches` still returns an array of `MatchResult`, one entry per project
whose archive was fetched successfully. Projects whose archive fetch fails are
omitted (their error is reported through the 4th `onProgress` argument —
`(done, total, currentRepo, error?)`). The library return shape is unchanged.

```ts
type MatchResult = {
  projectId: number;
  projectName: string;
  projectDescription: string | null;
  resultsLength: number;
  results: Array<{
    filename: string;    // e.g. "src/components/Foo.ts"
    matches: string[];   // which of `searchStrings` hit
    content: string[];   // full lines of the matching file
  }>;
};
```

### Library API (`fetchFiles`)

`fetchFiles` returns `{ repos: FetchedRepo[] }` — one entry per repo whose
file list was retrieved (including repos with zero matching files and repos
that failed mid-walk; those carry `error`). Files above `MAX_EMBED_BYTES`
(10 MB) are never embedded — text content is only embedded for UTF-8 files
at or below the cap (`FetchedFile.content`); binary and oversized files are
handed to the `saveFile` hook instead.

```ts
type FetchedRepo = {
  projectId: number;
  projectName: string;
  webUrl: string | null;
  branch: string;
  status: 'fetched' | 'not-found' | 'partial' | 'error';
  filesTotal: number;
  filesFetched: number;
  filesFailed: number;
  error: string | null;
  truncated: boolean;  // tree-pagination guard fired — file list may be incomplete
  files: Array<{
    projectId: number;
    repo: string;
    branch: string;
    path: string;              // repo-relative, no leading slash
    bytes: number | null;      // null for failed and large
    status: 'fetched' | 'binary' | 'failed' | 'large';
    content: string | null;    // embedded text only (status 'fetched')
    savedAs: string | null;    // from the saveFile hook
    error: string | null;
  }>;
};
```

### CLI report file / stdout

The CLI writes a **self-describing report object** instead of a bare array.
It has a `metadata` block plus a `repositories` array — one entry per repo
that was actually scanned (including zero-match repos and repos whose archive
could not be fetched; those carry `error` and, when it looks like the branch
is missing, `branchExists: false`).

```json
{
  "metadata": {
    "generatedAt": "2026-08-13T15:36:00.000Z",
    "branch": "develop",
    "searchStrings": ["console.log", "debugger"],
    "repoNameFilter": null,
    "fileInclude": [],
    "fileExclude": [],
    "excludeRepos": ["archived-repo"]
  },
  "repositories": [
    {
      "projectId": 42,
      "projectName": "frontend-app",
      "projectDescription": "Customer-facing web app",
      "webUrl": "https://gitlab.example.com/frontend-app",
      "branchExists": true,
      "error": null,
      "resultsLength": 1,
      "results": [
        {
          "filename": "src/components/Foo.ts",
          "matches": ["console.log"],
          "content": [
            "import { useState } from 'react';",
            "console.log('render');",
            "export const Foo = () => null;"
          ]
        }
      ]
    }
  ]
}
```

`--format txt` renders the same data as human-readable text (metadata lines
first, then per-repo file blocks with full `content`).


## Troubleshooting

### "Cannot run find-matches — missing required options:"

The CLI checked every source (CLI flags, env vars, config file, built-in
defaults) and still couldn't satisfy one or more required fields. The error
message itself tells you exactly which fields are missing and how to fix
each one. Example:

```
Error: Cannot run find-matches — missing required options:
  - gitlabUrl: Set GITLAB_URL in the environment (or .env), or add "gitlab.url" to gitlab-analyzer.json.
  - PRIVATE_TOKEN: Set PRIVATE_TOKEN in the environment (or .env). Tokens are never read from config files.
```

The most common fixes:

- Add `GITLAB_URL=` and `PRIVATE_TOKEN=` lines to a `.env` file in the
  current directory (it's already in `.gitignore`).
- Or export them in the shell: `export PRIVATE_TOKEN=... && export GITLAB_URL=...`
- Or add `"gitlab": { "url": "..." }` to `gitlab-analyzer.json` for the URL.

A config file is **never required** to run `gitlab-analyzer`.

### "401 Unauthorized"

Your GitLab token is missing or invalid. Make sure `PRIVATE_TOKEN` (or
`GITLAB_TOKEN`) is exported in the shell that runs the command, and that the
token has `read_api` scope on your GitLab instance.

### "404 Not Found" / "403 Forbidden" on a specific project

That project is unreachable with the current token — typically archived,
private without the right access, or removed mid-scan. The repo is skipped
from search results, but the report still lists it in `repositories` with the
error captured in `error` (and `branchExists: false` when the branch looks
missing). The remaining projects still produce results.

### Rate limiting / timeouts on large instances

GitLab imposes per-user request limits. Lower `--concurrency` to slow the
fan-out:

```bash
gitlab-analyzer find-matches 'TODO' --concurrency 2
```

A good rule of thumb is half of your instance's documented requests-per-second
limit.

### "Unrecognized key: \"token\"" at config load

You put a token (or any unknown field) into the `gitlab` block of the config.
The schema uses `.strict()` on the `gitlab` object, so any unknown key fails
validation. Move the token to the `PRIVATE_TOKEN` environment variable and
remove the field from the config file.

### No matches but the file definitely contains the string

By default every file in every archive is scanned. If you've set a narrowing
`fileInclude` (e.g. `'**/src/**'`) in your config, files outside that pattern
won't be scanned — drop the `fileInclude` line or override it with
`--file-include '**/*'` for that run:

```bash
gitlab-analyzer find-matches 'needle' --file-include '**/*'
```

Test files are scanned by default — exclude them with
`--file-exclude '**/*.test.ts'`.

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

## Security: tokens

Personal access tokens (`PRIVATE_TOKEN` / `GITLAB_TOKEN`) **must** come from
environment variables (or a local `.env` that is git-ignored). They are
**never** read from config files.

The zod schema uses `.strict()` on the `gitlab` object, so any config file
that tries to set `gitlab.token` (or any other unknown key) is rejected at
parse time with a clear `Unrecognized key: "token"` error. Tokens in committed
config files are an automatic config-load failure — by design.

## Status

Alpha. CLI + library surface complete, build emits dual ESM + CJS via **tsup**,
release infrastructure in place via [Changesets](https://github.com/changesets/changesets).
The single `find-matches` command is feature-complete against the MVP plan;
remaining work is end-to-end verification against a live GitLab instance.

Both module formats are published from a single source tree:

```js
// ESM
import { findMatches, fetchFiles, loadConfig } from 'gitlab-analyzer'

// CJS
const { findMatches, fetchFiles, loadConfig } = require('gitlab-analyzer')
```

Both resolve to the same public API (`findMatches`, `fetchFiles`,
`MAX_EMBED_BYTES`, `loadConfig`, types `FindMatchesOptions` / `MatchResult` /
`FetchFilesOptions` / `FetchFilesResult` / `FetchedRepo` / `FetchedFile` /
`SaveFileInput` / `SaveFileResult`). The CJS variant is emitted as
`dist/index.cjs` and the ESM variant as `dist/index.js`; types resolve via
the `exports["."].types` field to `dist/index.d.ts`.

## Releasing

This package uses [Changesets](https://github.com/changesets/changesets) for
versioning and publishing. The flow is fully manual — no CI automation.

### Per-PR: declare your change

Inside the branch that contains your change:

```bash
yarn changeset
```

Answer the prompts (bump type — `patch` / `minor` / `major`; affected packages
— `gitlab-analyzer`; short description). This writes a `.changeset/<random>.md`
file. Commit that file inside the same PR.

### Cut a release

On `main`, after merging one or more PRs with changeset entries:

```bash
yarn version
```

This runs the test suite, builds, and applies all pending changesets: bumps
`version` in `package.json`, regenerates `CHANGELOG.md`, and deletes the
consumed `.changeset/*.md` files.

> **Heads up:** `yarn version` includes an intermediate `changeset add` step
> (see `package.json`), which is **interactive** — it will prompt for a bump
> type and description before applying. If you only want to consume the
> already-merged changeset entries from your PRs, run `yarn changeset version`
> directly instead and skip the interactive step.

Review the diff, commit it (`chore: release <version>`), and push.

### Publish to npm

```bash
yarn publish-version
```

Runs tests + build + `changeset publish`. Requires you to be logged into the
npm CLI (`npm login`) with publish rights on the `gitlab-analyzer` package.
Also creates a `v<version>` git tag locally — push it separately with
`git push --tags` (or use `--follow-tags` on your next regular push).

## License

MIT — see [LICENSE](./LICENSE)
