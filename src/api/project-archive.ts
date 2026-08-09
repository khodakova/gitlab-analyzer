import { axiosInstance } from './config.ts';
import { red } from 'colorette';

export function getProjectArchive(projectId: number, options?: { projectName?: string, branch?: string }) {
  return axiosInstance.get<Blob>(`/api/v4/projects/${projectId}/repository/archive.zip`, {
    responseType: 'arraybuffer',
    params: {
      sha: options?.branch,
    }
  })
    .then((resp) => {
      return resp.data
    })
    .catch((err) => {
      console.error(red(`Не удалось получить архив по проекту ${options?.projectName} ${projectId}`));
      return null;
    })
}
