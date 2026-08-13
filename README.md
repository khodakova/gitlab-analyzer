# gitlab-analyzer

> CLI + library for mass analysis of GitLab repositories — search for specific
> strings across every project reachable from your GitLab instance.

## Features

- **`gitlab-analyzer find-strings <strings...>`** — find one or more substrings
  across every project in a GitLab instance, with filters for repo name,
  branch, path, and `*.test.*` files.
- **Programmatic API** — `import { findStrings, loadConfig } from 'gitlab-analyzer'`
  for custom post-processing pipelines.
- **Config-driven** — JSON / JS / TS config files via
  [cosmiconfig](https://github.com/davidtheclark/cosmiconfig), validated against
  a [zod](https://zod.dev) schema.
- **Parallel by default** — controlled concurrency via
  [`p-limit`](https://github.com/sindresorhus/p-limit), default 5 parallel
  archive fetches.
- **Pipeable JSON output** — results go to a file (`--output`) or stdout, with
  progress on stderr so the JSON stays clean for downstream tools.

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

The minimum to run `find-strings` is a working `.env` with your GitLab URL
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
   gitlab-analyzer find-strings 'console.log' 'debugger' \
     --branch develop \
     --output ./results.json
   ```

   Progress (`[3/12] my-frontend-app`) goes to **stderr**; the JSON array of
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
3. gitlab-analyzer.json config     defaults.*, commands.find-strings.*, gitlab.url
4. Built-in default                branch="develop", pathFilter="/src/", concurrency=5, ...
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
    "pathFilter": "/src/",
    "includeTests": false,
    "enableLogs": true
  },
  "commands": {
    "find-strings": {
      "concurrency": 5,
      "output": "./find-strings-result.json"
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
| `defaults.pathFilter` | string | `"/src/"` (built-in) | Substring filter for file paths |
| `defaults.includeTests` | boolean | `false` | Include `*.test.*` files |
| `defaults.enableLogs` | boolean | `false` | Enable debug/API logging (see [Logging](#logging)) |
| `commands.find-strings.concurrency` | int (positive) | `5` | Parallel requests to GitLab |
| `commands.find-strings.output` | string | — | Path to write JSON results |

## CLI Usage

The package ships one command today: `find-strings`. Run
`gitlab-analyzer --help` to list commands and `gitlab-analyzer find-strings
--help` for the full option reference.

### `find-strings` — option reference

```
gitlab-analyzer find-strings [options] <strings...>

Search for specific strings across all GitLab projects reachable from the
configured instance

Arguments:
  strings                  One or more search substrings; a file matches if it
                           contains ANY of them

Options:
  -r, --repo-filter <str>  Substring filter for project names (passed to GitLab search=)
  -e, --exclude <list>     Comma-separated list of repo names to skip
  -b, --branch <name>      Branch to scan in every project
  -p, --path-filter <str>  Substring filter for file paths inside the archive
      --include-tests      Include *.test.* files in the search
  -o, --output <path>      Path to write JSON results; omit to write to stdout
  -c, --concurrency <n>    Maximum number of parallel archive-fetch + zip-parse tasks
      --interactive        Let you choose which repositories to search
                           (space toggles a repo, Enter confirms); empty
                           selection cancels the run
      --enable-logs        Enable debug/API logging (also enabled automatically
                           with --interactive)
  -h, --help               display help for command
```

### Interactive repo selection

By default `find-strings` searches every reachable project (after
`excludeRepos`/`--exclude`). Pass `--interactive` to pick the repos yourself
before the search runs:

```bash
gitlab-analyzer find-strings 'TODO' --interactive
```

An `enquirer` multi-select list shows every repo initially selected. Use
**space** to toggle a repo, **arrows** to move, **Enter** to confirm. The
search then runs only against the repos you left selected. If you deselect
every repo and confirm, the run is cancelled (message on stderr, exit code 0,
no search). In non-interactive (default) mode the resolved repo list is printed
to stderr before searching so you can see where the search will run.

### Logging

By default the tool is quiet (`--enable-logs` is **off**): progress
(`[3/12] repo`), the summary line, and the pre-search repo list are always
printed to **stderr**, but debug/API output is suppressed.

Pass `--enable-logs` to turn on the full debug log: API request URLs,
"Найдено репозиториев: N", per-project recovery messages (e.g. an archive
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
gitlab-analyzer find-strings 'TODO' --enable-logs

# Equivalent via env var:
ENABLE_LOGS=true gitlab-analyzer find-strings 'TODO'
```

All log output goes to **stderr**, so the JSON result on stdout stays clean
and pipeable.

### Example invocation

```bash
PRIVATE_TOKEN=<your-private-token> \
  gitlab-analyzer find-strings 'console.log' 'debugger' \
    --repo-filter 'frontend' \
    --exclude 'archived-repo,wip-repo' \
    --branch develop \
    --output ./results/find-strings.json
```

### Multi-line invocations (PowerShell)

For longer commands, PowerShell continues a line with a backtick (`` ` ``)
at the end of each line. The `>>` prefix is PowerShell's continuation
prompt — type the backtick, press Enter, and keep typing. The output
filename uses `$(Get-Date -Format ...)` so each run lands in its own
file and nothing gets overwritten:

```powershell
node dist/cli.js find-strings 'string1', 'string2' `
  --repo-filter 'my-repo' `
  --include-tests `
  -o "./results/run-$(Get-Date -Format 'yyyy-MM-dd-HHmm').json"
```

### Output routing

- **`--output <path>`** (or `commands.find-strings.output` in the config)
  writes the JSON result to the given file.
- **No `--output` flag and no config default** — JSON is written to **stdout**.
- **Progress** (e.g. `[3/12] my-frontend-app`) and **error / summary lines**
  always go to **stderr**, so the stdout JSON stays clean for piping:

  ```bash
  gitlab-analyzer find-strings 'TODO' | jq '.[].projectName'
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
  findStrings,
  loadConfig,
  configureLogger,
  type FindStringsOptions,
  type MatchResult,
} from 'gitlab-analyzer';

const config = await loadConfig();

// Optional: turn on debug/API logging for library calls.
configureLogger({ enabled: true });

const results: MatchResult[] = await findStrings({
  searchStrings: ['console.log', 'debugger'],
  branch: config.defaults.branch,
  repoNameFilter: 'frontend',
  excludeRepos: ['archived-repo'],
  selectedRepos: [
    { id: 42, name: 'frontend-app' },
    { id: 7, name: 'backend-api' },
  ],
  pathFilter: '/src/',
  includeTests: false,
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

`findStrings` never writes files, never calls `console.*`, and never calls
`process.exit` — it is a pure async function returning the result array. All
output / progress / process management is the caller's responsibility when
using the library API directly.

The library also exports a small central logger — `configureLogger({ enabled })`
and `logger` (`logger.debug(...)`, `logger.error(...)`). It mirrors the CLI's
behavior: `debug` lines are silent unless enabled (default off), `error` lines
always print, and both go to **stderr**. Enable it when you want the internal
API/utils debug output for your own programmatic runs.

`findStrings` accepts an optional `projects` array of already-fetched
`SearchProjectsItem` objects. When provided, it skips the project-list fetch
(so `getAllProjects` is not called again) and just runs the search over that
list — useful when a caller has already loaded the repos (e.g. a CLI that built
the picker). `excludeRepos` / `selectedRepos` are still applied on top.

## Output Schema

`findStrings` returns an array of `MatchResult`, one entry per project whose
archive was fetched successfully. Projects whose archive fetch fails are
silently omitted.

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

A minimal example:

```json
[
  {
    "projectId": 42,
    "projectName": "frontend-app",
    "projectDescription": "Customer-facing web app",
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
```

## Troubleshooting

### "Cannot run find-strings — missing required options:"

The CLI checked every source (CLI flags, env vars, config file, built-in
defaults) and still couldn't satisfy one or more required fields. The error
message itself tells you exactly which fields are missing and how to fix
each one. Example:

```
Error: Cannot run find-strings — missing required options:
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
private without the right access, or removed mid-scan. The tool silently
skips it; the remaining projects still produce results.

### Rate limiting / timeouts on large instances

GitLab imposes per-user request limits. Lower `--concurrency` to slow the
fan-out:

```bash
gitlab-analyzer find-strings 'TODO' --concurrency 2
```

A good rule of thumb is half of your instance's documented requests-per-second
limit.

### "Unrecognized key: \"token\"" at config load

You put a token (or any unknown field) into the `gitlab` block of the config.
The schema uses `.strict()` on the `gitlab` object, so any unknown key fails
validation. Move the token to the `PRIVATE_TOKEN` environment variable and
remove the field from the config file.

### No matches but the file definitely contains the string

The default `pathFilter` is `'/src/'`, so files outside any `src` directory
are skipped. Pass `--path-filter '/'` to scan every file in every archive:

```bash
gitlab-analyzer find-strings 'needle' --path-filter '/'
```

`*.test.*` files are excluded by default — pass `--include-tests` to include
them.

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
The single `find-strings` command is feature-complete against the MVP plan;
remaining work is end-to-end verification against a live GitLab instance.

Both module formats are published from a single source tree:

```js
// ESM
import { findStrings, loadConfig } from 'gitlab-analyzer'

// CJS
const { findStrings, loadConfig } = require('gitlab-analyzer')
```

Both resolve to the same public API (`findStrings`, `loadConfig`, types
`FindStringsOptions` / `MatchResult`). The CJS variant is emitted as
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
