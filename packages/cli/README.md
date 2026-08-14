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
npx gitlab-analyzer find-strings 'console.log' 'debugger'
```

For a stable version, pin it explicitly:

```bash
npx gitlab-analyzer@0.1.0 find-strings 'console.log'
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
   gitlab-analyzer find-strings 'console.log' 'debugger'
   ```

Progress (`Processed 3 of 12 · my-frontend-app`) goes to **stderr**; the report goes to `find-strings-results-<date>.json`.

---

## `find-strings` — all options

```
gitlab-analyzer find-strings [options] <strings...>
```

| Option | Description | Default |
|---|---|---|
| `<strings...>` | One or more search strings. A file matches if it contains **ANY** of them (required) | — |
| `-r, --repo-filter <str>` | Substring filter for project names (passed to GitLab `search=`) | — |
| `-e, --exclude <list>` | Comma-separated repo names to skip | `[]` |
| `-b, --branch <name>` | Branch to scan in every project | `develop` |
| `-p, --path-filter <str>` | Substring filter for file paths inside the archive | `/src/` |
| `--include-tests` | Include `*.test.*` files in the search | off |
| `--format <txt\|json>` | Report format (also drives the file extension) | `json` |
| `--stdout` | Also write the report to stdout (handy for piping) | off |
| `-o, --output <path>` | Where to write the report; omit for an auto-generated name | auto-name |
| `-c, --concurrency <n>` | Max parallel archive-fetch + zip-parse tasks | `5` |
| `--interactive` | Pick repos manually before searching (space toggles, Enter confirms) | off |
| `--enable-logs` | Verbose debug/API logging (auto-enabled with `--interactive`) | off |
| `-h, --help` | Show help | — |

> Note: if `--format` conflicts with the extension of an explicit `--output` (e.g. `--format txt -o out.json`), the command fails with an error and writes nothing.

### Examples

**Linux / macOS (bash/zsh):**

```bash
# Minimal run (requires .env)
gitlab-analyzer find-strings 'console.log' 'debugger'

# Frontend repos only, skipping archives, on your branch, report to a file
gitlab-analyzer find-strings 'TODO' 'FIXME' \
  --repo-filter 'frontend' \
  --exclude 'archived-repo,wip-repo' \
  --branch develop \
  -o ./results/find-strings.json

# Scan everything (tests + all paths) to one file
gitlab-analyzer find-strings 'legacy-sdk' \
  --path-filter '/' \
  --include-tests \
  --format json -o results.json

# Report straight to stdout for jq (no file written)
gitlab-analyzer find-strings 'UPDATE' --stdout | jq '.metadata.branch'

# Interactive repo selection
gitlab-analyzer find-strings 'release-it' --interactive

# Without installing — via npx
npx gitlab-analyzer find-strings 'console.log' 'debugger'
```

**Windows (PowerShell):** line continuation uses a backtick (`` ` ``); set env vars via `$env:`.

```powershell
# Minimal run
gitlab-analyzer find-strings 'console.log' 'debugger'

# Full example — `` ` `` line breaks and a time-stamped file name
gitlab-analyzer find-strings 'TODO' 'FIXME' `
  --repo-filter 'frontend' `
  --exclude 'archived-repo,wip-repo' `
  --branch develop `
  -o "./results/run-$(Get-Date -Format 'yyyy-MM-dd-HHmm').json"

# Token set inline
$env:PRIVATE_TOKEN="glpat-xxxx"; gitlab-analyzer find-strings 'console.log'

# To stdout, parsed with jq
gitlab-analyzer find-strings 'TODO' --stdout | jq '.repositories[].projectName'
```

**Windows (cmd):** line continuation uses `^`, env vars via `set`:

```bat
set PRIVATE_TOKEN=glpat-xxxx
gitlab-analyzer find-strings "console.log" "debugger" ^
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
3. gitlab-analyzer.json      defaults.*, commands.find-strings.*, gitlab.url
4. Built-in default          branch="develop", pathFilter="/src/", concurrency=5
```

A config is useful for **persistent, non-secret** values (branch, exclusions, concurrency, output path). **Never** put tokens in a config — env only.

```json
{
  "gitlab": { "url": "https://gitlab.example.com" },
  "defaults": {
    "branch": "develop",
    "repoNameFilter": "frontend",
    "excludeRepos": ["archived-repo", "wip-repo"],
    "pathFilter": "/src/",
    "includeTests": false
  },
  "commands": {
    "find-strings": {
      "concurrency": 5,
      "output": "./results/find-strings.json"
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
| `defaults.pathFilter` | `"/src/"` | Substring filter for file paths |
| `defaults.includeTests` | `false` | Include `*.test.*` |
| `defaults.enableLogs` | `false` | Enable debug logging |
| `commands.find-strings.concurrency` | `5` | Parallel requests |
| `commands.find-strings.output` | — | Report path |

## Exporting results

- **`--output <path>`** — write the report to the given file.
- **Without `--output`** — auto-name `find-strings-results-<date>.json` (or `.txt` with `--format txt`); a numeric suffix `-1`, `-2`… is appended if the name is taken.
- **`--stdout`** — additionally write the report to stdout (for piping).
- Progress and errors always go to **stderr**, so stdout stays clean.

```bash
gitlab-analyzer find-strings 'TODO' --stdout | jq '.repositories[].projectName'
```

## Good to know

- **No matches but the string is definitely there?** The default `--path-filter /src/` skips files outside `src`. Scan everything: `--path-filter '/'`.
- **Tests are excluded by default** — add `--include-tests`.
- **Too many requests on a big instance?** Lower `--concurrency 2`.
- **401 Unauthorized** — check `PRIVATE_TOKEN` (needs `read_api` scope).
- Tokens are read **only** from env vars / `.env` — never from config.

## CLI help

```bash
gitlab-analyzer --help
gitlab-analyzer find-strings --help
```

## License

MIT.
