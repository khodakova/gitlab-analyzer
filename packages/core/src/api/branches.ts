import { axiosInstance } from './config.ts';
import axios from 'axios';

/**
 * Asks GitLab for the repository's default branch (needed as the source for a new branch).
 *
 * @param repoId project identifier in GitLab.
 * @returns name of the default branch.
 */
async function getDefaultBranch(repoId: number): Promise<string> {
  try {
    const { data } = await axiosInstance.get<{ default_branch?: string }>(
      `/api/v4/projects/${encodeURIComponent(repoId)}`,
    );
    if (!data.default_branch) {
      throw new Error('The project has no default branch set');
    }
    return data.default_branch;
  } catch (e) {
    if (axios.isAxiosError(e) && e.response) {
      throw new Error(`GET project: ${e.response.status} ${e.response.statusText}`);
    }
    throw e;
  }
}

/**
 * Checks whether a branch exists in the repository. If it does not — creates it from `fromRef`.
 *
 * @param repoId project identifier.
 * @param branch name of the branch to ensure.
 * @param fromRef branch/tag from which a new branch is created if it does not exist yet.
 */
export async function ensureOrCreateBranch(repoId: number, branch: string, fromRef: string): Promise<void> {
  try {
    await axiosInstance.get(
      `/api/v4/projects/${encodeURIComponent(repoId)}/repository/branches/${encodeURIComponent(branch)}`,
    );
    return;
  } catch (e) {
    if (axios.isAxiosError(e)) {
      if (e.response?.status !== 404) {
        throw new Error(`GET branch: ${e.response?.status} ${e.response?.statusText}`);
      }
    } else {
      throw e;
    }
  }
  await axiosInstance.post(
    `/api/v4/projects/${encodeURIComponent(repoId)}/repository/branches`,
    { branch, ref: fromRef },
  );
}
