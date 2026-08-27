import axios from 'axios';
import { axiosErrorBody, axiosInstance } from './config.ts';



/**
 * Looks up an already-open MR from the given source branch — needed as a fallback
 * if GitLab refused to create an MR because of a duplicate.
 */
async function findExistingMr(repoId: number, sourceBranch: string): Promise<string | null> {
  try {
    const { data } = await axiosInstance.get<Array<{ web_url?: string }>>(
      `/api/v4/projects/${repoId}/merge_requests?state=opened&source_branch=${encodeURIComponent(sourceBranch)}`,
    );
    return data[0]?.web_url ?? null;
  } catch {
    return null;
  }
}

/**
 * Creates an MR from sourceBranch into targetBranch. The MR is not merged
 * automatically: it is created in an open state and waits for a manual action.
 *
 * @param params.repoId project identifier in GitLab.
 * @param params.sourceBranch source branch name (contains the change).
 * @param params.targetBranch target branch name.
 * @param params.title MR title.
 * @param params.description MR description.
 * @returns URL of the created (or already existing) MR.
 */
export async function createMr({
  repoId,
  sourceBranch,
  targetBranch,
  title,
  description,
}: {
  repoId: number,
  sourceBranch: string,
  targetBranch: string,
  title: string,
  description: string,
}): Promise<string> {
  try {
    const { data } = await axiosInstance.post<{ web_url?: string }>(
      `/api/v4/projects/${repoId}/merge_requests`,
      {
        source_branch: sourceBranch,
        target_branch: targetBranch,
        title,
        description,
        remove_source_branch: true,
      },
    );
    if (!data.web_url) throw new Error('MR created, but web_url was not returned');
    return data.web_url;
  } catch (e) {
    const existing = await findExistingMr(repoId, sourceBranch);
    if (existing) return existing;
    if (axios.isAxiosError(e) && e.response) {
      throw new Error(
        `POST merge_requests: ${e.response.status} ${e.response.statusText}${axiosErrorBody(e)}`,
      );
    }
    throw e;
  }
}
