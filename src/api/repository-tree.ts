import { axiosInstance } from './config.ts';

/**
 * Получить файлы внутри директории или контент в файле
 * @param projectId
 * @param filePath
 */
export function getGitTree(projectId: number, filePath?: string) {
  const fileNameEncoded = filePath ? encodeURIComponent(encodeURI(filePath)) : '';
  console.log(`/api/v4/projects/${projectId}/repository/tree?path=${fileNameEncoded || ''}`)
  return axiosInstance.get<Blob>(`/api/v4/projects/${projectId}/repository/tree?path=${fileNameEncoded || ''}`)
    .then((resp) => {
      return resp.data
    })
    .catch((err) => {
      // console.error(`Не удалось получить файлы по проекту ${projectId}`);
      // console.error(`Не удалось получить файлы по проекту ${projectId}`,err);
      return null;
    })
}
