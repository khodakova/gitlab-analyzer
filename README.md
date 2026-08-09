# gitlab-analyzer

> CLI + library for mass analysis of GitLab repositories

**Status:** Pre-alpha (Phase 1 — configuration system complete; CLI in progress)

## Planned features

- `gitlab-analyzer find-strings <strings...>` — find specific strings across all projects in a GitLab instance
- Library API: `import { findStrings, loadConfig } from 'gitlab-analyzer'`

## Installation

```bash
yarn global add gitlab-analyzer
```

## Configuration

`gitlab-analyzer` reads configuration from JSON / JS / TS files via [cosmiconfig](https://github.com/davidtheclark/cosmiconfig). Files are looked up in two layers (project and user-home), merged with built-in defaults, and validated against a [zod](https://zod.dev) schema. Only the config-file layers and built-in defaults are implemented in Phase 1; CLI-flag and env-var merging lands in Phase 3.

### Search locations

Two layers are searched, in this order (first match wins):

**Project layer** — `process.cwd()` and each parent directory up to the filesystem root, looking for any of:

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

If nothing is found in either layer, `loadConfig()` throws with an instruction telling you where to create the config.

### Priority

When all layers are merged, the precedence (highest wins) is:

```
CLI flags  >  environment variables  >  project config  >  home config  >  built-in defaults
```

Only the last three are active today; CLI-flag and env-var merging ship with the `find-strings` command in Phase 3.

### Minimal example

The smallest valid config contains only your GitLab URL. Everything else falls back to defaults:

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

Field reference:

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

### Security: tokens

Personal access tokens (`PRIVATE_TOKEN` / `GITLAB_TOKEN`) **must** come from environment variables (or a local `.env` that is git-ignored). They are **never** read from config files.

The zod schema uses `.strict()` on the `gitlab` object, so any config file that tries to set `gitlab.token` (or any other unknown key) is rejected at parse time with a clear `Unrecognized key: "token"` error. Tokens in committed config files are an automatic config-load failure — by design.

## License

MIT — see [LICENSE](./LICENSE)
