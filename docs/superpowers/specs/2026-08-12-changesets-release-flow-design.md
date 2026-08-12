# Changesets Release Flow — Design Spec

**Date:** 2026-08-12
**Status:** Approved (infrastructure-only)
**Author:** Sisyphus (via brainstorming session)

## Goal

Add [Changesets](https://github.com/changesets/changesets) to `gitlab-analyzer`
so that version bumps and `CHANGELOG.md` generation become declarative per-PR,
and `npm publish` becomes a single local command. Replicate the exact manual
flow already established in `saltify-pinia-stores`.

## Out of scope

- GitHub Actions / CI automation of releases (manual flow only — matches reference)
- First concrete release (no `changeset version` + `changeset publish` executed
  in this change; current `0.1.0` stays as-is on `main` until the user drives
  the first release manually)
- Migrating to a monorepo / multi-package layout

## Locked decisions (from brainstorming)

| Decision | Value | Rationale |
|---|---|---|
| Release flow | Fully manual, run locally | Matches saltify-pinia-stores exactly |
| npm scope | `public` (publishes to https://registry.npmjs.org) | User confirmed |
| First release | Deferred | User confirmed — only infrastructure now |
| Changeset versions | `@changesets/cli@2.27.7`, `@changesets/changelog-git@0.2.0` | Identical to saltify |
| Changelog generator | `@changesets/cli/changelog` (default) | Identical to saltify |
| `baseBranch` | `main` | Matches both repo's current branch and saltify |
| `access` in changeset config | `restricted` (default) | Matches saltify; per-package `publishConfig` controls actual scope |
| `publishConfig` in `package.json` | `{ "access": "public" }` | Drives npm publish to public registry |

## File-by-file changes

### New: `.changeset/config.json`

Verbatim copy of the reference config (proven working in saltify-pinia-stores):

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.2/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "restricted",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

### New: `.changeset/README.md`

Verbatim copy of the auto-generated README that `@changesets/cli init` produces.
Identical content to saltify's. Purpose: GitHub renders the `.changeset/` folder
nicely and points new contributors at the official docs.

### Edit: `package.json`

Four additive changes — no existing field is modified or removed:

1. **Repository metadata** (currently empty strings — npm `publish` rejects this):

   ```json
   "repository": {
     "type": "git",
     "url": "git+https://github.com/khodakova/gitlab-analyzer.git"
   },
   "bugs": {
     "url": "https://github.com/khodakova/gitlab-analyzer/issues"
   },
   "homepage": "https://github.com/khodakova/gitlab-analyzer#readme",
   "author": "khodakova",
   ```

2. **publishConfig** (drives `npm publish` to public registry):

   ```json
   "publishConfig": {
     "access": "public"
   },
   ```

3. **devDependencies** — add (versions match saltify for consistency):

   ```json
   "@changesets/cli": "2.27.7",
   "@changesets/changelog-git": "0.2.0",
   ```

4. **scripts** — add two release scripts:

   ```json
   "version": "yarn test && yarn build && changeset add && changeset version",
   "publish-version": "yarn test && yarn build && yarn changeset publish"
   ```

   Note on script choice: saltify uses `yarn test:once`; gitlab-analyzer's
   existing `test` script is already non-watch (`vitest run`), so `test`
   is the correct equivalent. No need to introduce a `test:once` alias.

### Edit: `README.md`

Update the **Status** section to reflect that release infrastructure is now in
place, and add a **Releasing** subsection covering the full workflow.

#### Status — current text

```
Alpha (Phase 3 — CLI + library surface complete; Phase 4 — build migrated to
**tsup** with dual ESM + CJS output). The single `find-strings` command is
feature-complete against the MVP plan; remaining work is end-to-end verification
against a live GitLab instance (Phase 5) and a public release (Phase 5 publish).
```

#### Status — replacement

```
Alpha. CLI + library surface complete, build emits dual ESM + CJS via **tsup**,
release infrastructure in place via [Changesets](https://github.com/changesets/changesets).
The single `find-strings` command is feature-complete against the MVP plan;
remaining work is end-to-end verification against a live GitLab instance.
```

#### New subsection (appended after the existing "Status" / before "License")

```
## Releasing

This package uses [Changesets](https://github.com/changesets/changesets) for
versioning and publishing. The flow is fully manual — no CI automation.

### Per-PR: declare your change

Inside the branch that contains your change:

\`\`\`bash
yarn changeset
\`\`\`

Answer the prompts (bump type — `patch` / `minor` / `major`; affected packages
— `gitlab-analyzer`; short description). This writes a `.changeset/<random>.md`
file. Commit that file inside the same PR.

### Cut a release

On `main`, after merging one or more PRs with changeset entries:

\`\`\`bash
yarn version
\`\`\`

This runs the test suite, builds, and applies all pending changesets: bumps
`version` in `package.json`, regenerates `CHANGELOG.md`, and deletes the
consumed `.changeset/*.md` files.

Review the diff, commit it (`chore: release <version>`), and push.

### Publish to npm

\`\`\`bash
yarn publish-version
\`\`\`

Runs tests + build + `changeset publish`. Requires you to be logged into the
npm CLI (`npm login`) with publish rights on the `gitlab-analyzer` package.
Also pushes the version tag to the git remote.
```

## Files explicitly NOT touched

| File | Reason |
|---|---|
| `.gitignore` | Changeset `.md` files are committed (changesets default workflow). Confirmed by inspecting saltify-pinia-stores's `.gitignore`. |
| `.npmignore` | The `files` field in `package.json` (`["dist/", "README.md", "LICENSE"]`) already excludes `.changeset/` from the npm tarball. |
| `.github/` | Manual release flow — no CI workflows needed. |
| `tsup.config.ts`, `tsconfig.json`, `vitest.config.ts` | Build / test config unrelated to release flow. |
| `src/` | No source-code changes required. |

## Implementation notes

- **Order of operations matters when editing `package.json`** to keep the JSON
  valid throughout the edit. The four additive blocks are independent in JSON
  terms but should be applied via a single rewrite of the file (not four
  separate `edit` tool calls) to avoid producing intermediate invalid JSON.
- **`@changesets/cli` 2.27.7 is the latest 2.x at time of writing** — using the
  same version as saltify keeps the lockfile diff minimal and lets both repos
  share the same documentation in muscle memory.
- **No need to run `yarn install`** as part of this spec — yarn will pick up
  the new devDependencies on the next `yarn` / `yarn install` invocation.

## Verification (post-implementation)

1. `yarn install` succeeds (picks up new devDeps).
2. `yarn changeset --help` runs without error.
3. `cat .changeset/config.json` matches the spec verbatim.
4. `cat package.json` shows all four additive blocks present and no existing
   fields removed.
5. `git status` shows only the expected new/modified files (`.changeset/`,
   `package.json`, `README.md`, `yarn.lock` from the new devDeps).
6. `yarn build` still succeeds (sanity — no breakage from package.json shape).
7. `yarn test` still succeeds (sanity).

No release is performed as part of this change.

## Risk / rollback

- **Low risk.** No runtime code changes; only metadata + tooling config + docs.
- **Rollback:** revert the commit. All four files are reversible by `git revert`
  or `git checkout HEAD~1 -- <path>`.
- **Lockfile**: `yarn.lock` will change (new devDeps). This is expected and
  should be committed alongside.
