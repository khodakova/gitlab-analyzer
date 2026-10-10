import { axiosInstance } from './config.ts';
import type { Commit } from '../types.ts';

/**
 * Parameters for {@link getCommits}. `ref_name` is required — GitLab defaults
 * it to the project's default branch, but relying on that hides which branch
 * was actually scanned.
 */
export type GetCommitsParams = {
  /** Restrict commits to those touching this file path. */
  path?: string,
  ref_name: string,
  since?: string,
  until?: string,
  per_page?: number,
};

/**
 * List commits of a repository via the GitLab commits REST API.
 *
 * Errors are PROPAGATED (never swallowed into `null`), mirroring
 * `project-archive.ts`: the caller decides per-repo recovery (e.g. a 404
 * "branch not found" becomes a repo error with `branchExists: false`).
 * A timeout (AbortSignal) is rewritten into a human-readable message;
 * axios errors keep their native message ("Request failed with status
 * code 404") so `isBranchMissingError` heuristics keep working.
 */
export async function getCommits(
  projectId: number,
  params: GetCommitsParams,
): Promise<Commit[]> {
  try {
    const resp = await axiosInstance.get<Commit[]>(
      `/api/v4/projects/${projectId}/repository/commits`,
      {
        params,
        // Hard-abort at 60s (same guard as the archive download): bare axios
        // `timeout` does not abort a server that stopped sending data, and a
        // stuck request would hold its p-limit slot indefinitely.
        signal: AbortSignal.timeout(60_000),
      },
    );
    return resp.data;
  } catch (err) {
    const isTimeout =
      (err as { cause?: { name?: string } | DOMException } | null)?.cause?.name === 'TimeoutError';
    throw isTimeout ? new Error('commits request timed out (60s)') : err;
  }
}

/**
 * Write (create/update) a file in the repository with a single commit via the
 * GitLab Repository Files API.
 *
 * @param params.repoId project identifier in GitLab.
 * @param params.filePath path to the file relative to the repository root (e.g. `package.json`).
 * @param params.branch name of the branch we commit to.
 * @param params.content new file content as a string.
 * @param params.commitMessage commit text.
 */
export async function commitFile({
  repoId,
  filePath,
  branch,
  content,
  commitMessage,
}: {
  repoId: number,
  filePath: string,
  branch: string,
  content: string,
  commitMessage: string,
}): Promise<void> {
  const path = encodeURIComponent(filePath);
  await axiosInstance.put(
    `/api/v4/projects/${repoId}/repository/files/${path}`,
    {
      branch,
      content,
      encoding: 'text',
      commit_message: commitMessage,
    },
  );
}
