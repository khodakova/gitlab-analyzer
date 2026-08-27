import { axiosInstance } from './config.ts';

/**
 * Get commits by file
 */
export function getCommits(projectId: number, params?: {path: string, ref_name: string, since: string}) {
  return axiosInstance.get<Blob>(`/api/v4/projects/${projectId}/repository/commits`, {
    params
  })
    .then((resp) => {
      return resp.data
    })
    .catch((err) => {
      return null;
    })
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
