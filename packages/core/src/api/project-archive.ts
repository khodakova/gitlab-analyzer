import { axiosInstance } from './config.ts';
import { red } from 'colorette';
import { logger } from '../utils/logger.ts';

export async function getProjectArchive(projectId: number, options?: { projectName?: string, branch?: string }) {
  try {
    const resp = await axiosInstance.get<Blob>(`/api/v4/projects/${projectId}/repository/archive.zip`, {
      responseType: 'arraybuffer',
      params: {
        sha: options?.branch,
      }
    });
    return resp.data;
  } catch (err) {
    // Per-project recovery: the archive for a single repo is unreachable
    // (archived / private / removed mid-scan, or the requested branch does
    // not exist). The repo is skipped and the scan continues, so this is NOT
    // an unconditional error — it's debug output gated by `--enable-logs` /
    // `--interactive`. The error message is re-thrown so the caller can
    // surface it (e.g. in report metadata `error` / `branchExists: false`).
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(red(`Не удалось получить архив по проекту ${options?.projectName} ${projectId}: ${message}`));
    throw err;
  }
}
