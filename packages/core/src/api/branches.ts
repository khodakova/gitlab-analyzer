import { axiosInstance } from './config.ts';
import axios from 'axios';

/**
 * Запрашивает у GitLab default-ветку репозитория (нужна как источник для новой ветки).
 *
 * @param repoId идентификатор проекта в GitLab.
 * @returns имя default-ветки.
 */
async function getDefaultBranch(repoId: number): Promise<string> {
  try {
    const { data } = await axiosInstance.get<{ default_branch?: string }>(
      `/api/v4/projects/${encodeURIComponent(repoId)}`,
    );
    if (!data.default_branch) {
      throw new Error('У проекта не задана default branch');
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
 * Проверяет существование ветки в репозитории. Если её нет — создаёт от `fromRef`.
 *
 * @param repoId идентификатор проекта.
 * @param branch имя ветки, которую нужно обеспечить.
 * @param fromRef ветка/тег, от которой создаётся новая ветка, если её ещё нет.
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
