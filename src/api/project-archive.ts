import { axiosInstance } from './config.ts';
import { red } from 'colorette';
import { logger } from '../utils/logger.ts';

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
      // Per-project recovery: the archive for a single repo is unreachable
      // (archived / private / removed mid-scan). The repo is skipped and the
      // scan continues, so this is NOT an unconditional error — it's debug
      // output gated by `--enable-logs` / `--interactive`.
      logger.debug(red(`Не удалось получить архив по проекту ${options?.projectName} ${projectId}`));
      return null;
    })
}
