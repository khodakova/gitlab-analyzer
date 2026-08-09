# gitlab-analyzer

> CLI + library for mass analysis of GitLab repositories

**Status:** Pre-alpha (Phase 0 scaffold — not yet functional)

## Planned features

- `gitlab-analyzer find-strings <strings...>` — find specific strings across all projects in a GitLab instance
- Library API: `import { findStrings, loadConfig } from 'gitlab-analyzer'`

## Installation

```bash
yarn global add gitlab-analyzer
```

## Configuration

See `.env.example` for environment variables and `gitlab-analyzer.json.example` for config file format.

Full documentation will be added in Phase 4.

## License

MIT — see [LICENSE](./LICENSE)
