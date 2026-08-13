import { axiosInstance } from './config.ts';

/**
 * Получить коммиты по файлу
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
 * Записать (создать/обновить) файл в репозитории одним коммитом через
 * GitLab Repository Files API.
 *
 * @param params.repoId идентификатор проекта в GitLab.
 * @param params.filePath путь к файлу относительно корня репозитория (например, `package.json`).
 * @param params.branch имя ветки, в которую коммитим.
 * @param params.content новое содержимое файла в виде строки.
 * @param params.commitMessage текст коммита.
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
