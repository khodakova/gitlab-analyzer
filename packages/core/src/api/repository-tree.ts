import { axiosInstance } from './config.ts';
import { logger } from '../utils/logger.ts';

/**
 * Get files inside a directory or the content of a file
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
      // console.error(`Failed to get files for project ${projectId}`);
      // console.error(`Failed to get files for project ${projectId}`,err);
      return null;
    })
}
