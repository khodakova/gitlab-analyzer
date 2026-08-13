import { axiosInstance } from './config.ts';
import { logger } from '../utils/logger.ts';

/**
 * Получить файлы внутри директории или контент в файле
 * @param projectId
 * @param filePath
 */
export function getGitTree(projectId: number, filePath?: string) {
  const fileNameEncoded = filePath ? encodeURIComponent(encodeURI(filePath)) : '';
  logger.debug(`/api/v4/projects/${projectId}/repository/tree?path=${fileNameEncoded || ''}`)
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
