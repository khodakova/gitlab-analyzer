import type { SearchMetrics } from '@gitlab-analyzer/core/internal';
import type { FindMatchesCliOptions } from '../utils/options.ts';
import { report } from '../utils/progress.ts';
import { fetchRepoList, prepareApiAccess } from './find-matches.ts';

/**
 * `list-repos`: print the repositories that the shared filters select for
 * `find-matches` — without downloading archives or searching. Intended as a
 * pre-flight check so the user can evaluate the repo list (tune
 * `--repo-filter` / `--exclude` / config `defaults.*`) before a long scan.
 *
 * Only repo-level filters apply here (repo name filter + exclusions, same
 * filtering as `resolveReposToScan` in find-matches). `--branch` and the file
 * globs do NOT shrink the repo list — they act later, during the scan — so
 * repos with a missing branch or fully-filtered files still appear here.
 *
 * Output contract: names on **stdout** (one per line, sorted), progress and
 * the count summary on **stderr** — the list stays pipeable
 * (`gitlab-analyzer list-repos | wc -l`). Empty result is not an error: a
 * message goes to stderr and the process exits 0 (same semantics as the
 * no-repos guard in find-matches).
 *
 * @returns The sorted list of repository names.
 */
export async function runListRepos(
  opts: FindMatchesCliOptions,
): Promise<string[]> {
  // Placeholder strings: `resolveOptions` enforces non-empty strings for
  // find-matches; `list-repos` takes no positionals, so pass a stand-in that
  // satisfies the check without contributing anything else.
  const { resolved } = await prepareApiAccess('list-repos', ['list-repos'], opts);

  const metrics: SearchMetrics = {
    list: { listMs: 0, pagesFetched: 0, reposFound: 0 },
    perRepo: [],
    summary: {},
  };
  const allProjects = await fetchRepoList(resolved.repoNameFilter, metrics);

  const excludeList = resolved.excludeRepos;
  const repos = allProjects
    .filter(
      (project) =>
        project.name !== null &&
        project.name.length > 0 &&
        !excludeList.includes(project.name),
    )
    .map((project) => project.name as string)
    // The list API is queried with order_by=name asc, but sort anyway so the
    // output stays alphabetical regardless of API-side ordering behaviour.
    .sort();

  if (repos.length === 0) {
    report('No repositories found: filters/exclusions produced no results.');
    return repos;
  }

  for (const name of repos) {
    process.stdout.write(`${name}\n`);
  }
  report(`Found ${repos.length} repositories matching the filters.`);
  return repos;
}
