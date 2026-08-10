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

1. **Create a config** at `./gitlab-analyzer.json` (next to where you'll run
   the binary, or under `~/.config/gitlab-analyzer/config.json`):

   ```json
   {
     "gitlab": {
       "url": "https://gitlab.example.com"
     }
   }
   ```

2. **Export your GitLab token** as an environment variable — the config never
   holds secrets:

   ```bash
   export PRIVATE_TOKEN=<your-private-token>
   ```

3. **Run a search**:

   ```bash
   gitlab-analyzer find-strings 'console.log' 'debugger' \
     --branch develop \
     --output ./results.json
   ```

   Progress (`[3/12] my-frontend-app`) goes to **stderr**; the JSON array of
   matches goes to `./results.json`.

## Configuration

`gitlab-analyzer` reads configuration from JSON / JS / TS files via
[cosmiconfig](https://github.com/davidtheclark/cosmiconfig). Files are looked
up in two layers (project and user-home), merged with built-in defaults, and
validated against a [zod](https://zod.dev) schema.

### Search locations

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

If nothing is found in either layer, `loadConfig()` throws with an instruction
telling you where to create the config.

### Priority

When all layers are merged, the precedence (highest wins) is:

```
CLI flags  >  environment variables  >  project config  >  home config  >  built-in defaults
```

All five sources are active in `find-strings`: CLI flags win, then
environment variables (e.g. `PRIVATE_TOKEN`), then config files, then the
schema defaults.

### Minimal example

The smallest valid config contains only your GitLab URL. Everything else falls
back to defaults:

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
    "includeTests": false
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
| `gitlab.url` | string (URL) | — (required) | Base URL of your GitLab instance |
| `defaults.branch` | string | `"develop"` | Branch to scan |
| `defaults.repoNameFilter` | string | — | Substring filter for repo names |
| `defaults.excludeRepos` | string[] | `[]` | Repo names to skip |
| `defaults.pathFilter` | string | — | Substring filter for file paths |
| `defaults.includeTests` | boolean | `false` | Include `*.test.*` files |
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
  -h, --help               display help for command
```

### Example invocation

```bash
PRIVATE_TOKEN=<your-private-token> \
  gitlab-analyzer find-strings 'console.log' 'debugger' \
    --repo-filter 'frontend' \
    --exclude 'archived-repo,wip-repo' \
    --branch develop \
    --output ./results/find-strings.json
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
  type FindStringsOptions,
  type MatchResult,
} from 'gitlab-analyzer';

const config = await loadConfig();

const results: MatchResult[] = await findStrings({
  searchStrings: ['console.log', 'debugger'],
  branch: config.defaults.branch,
  repoNameFilter: 'frontend',
  excludeRepos: ['archived-repo'],
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

### "No configuration found"

`loadConfig()` did not find any of the supported config files. Create
`gitlab-analyzer.json` in your project root or
`~/.config/gitlab-analyzer/config.json` with at minimum:

```json
{
  "gitlab": {
    "url": "https://your-gitlab.example.com"
  }
}
```

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

Alpha (Phase 3 — CLI + library surface complete; Phase 4 — build migrated to
**tsup** with dual ESM + CJS output). The single `find-strings` command is
feature-complete against the MVP plan; remaining work is end-to-end
verification against a live GitLab instance (Phase 5) and a public release
(Phase 5 publish).

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

## License

MIT — see [LICENSE](./LICENSE)
