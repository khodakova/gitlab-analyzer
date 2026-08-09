import axios from 'axios';
import { axiosErrorBody, axiosInstance } from './config.ts';



/**
 * Ищет уже открытый MR из указанной source-ветки — нужно как fallback,
 * если GitLab отказался создавать MR из-за дубля.
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
 * Создаёт MR из sourceBranch в targetBranch. MR не сливается автоматически:
 * создаётся в открытом состоянии и ждёт ручного действия.
 *
 * @param params.repoId идентификатор проекта в GitLab.
 * @param params.sourceBranch имя исходной ветки (содержит правку).
 * @param params.targetBranch имя целевой ветки.
 * @param params.title заголовок MR.
 * @param params.description описание MR.
 * @returns URL созданного (или уже существующего) MR.
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
    if (!data.web_url) throw new Error('MR создан, но не вернулся web_url');
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
