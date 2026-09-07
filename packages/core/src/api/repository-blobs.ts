import type { Readable } from 'node:stream';
import { axiosInstance } from './config.ts';
import { logger } from '../utils/logger.ts';

type FetchBlobRawOptions = {
  projectName?: string;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Raw blob download primitive: GET `/api/v4/projects/:id/repository/blobs/:sha/raw`
 * with `responseType: 'stream'`, returning the Node `Readable` from `resp.data`.
 *
 * Retry policy (D23): ONLY HTTP 429 is retried — at most `maxRetries` (default 2)
 * times, so up to 3 attempts total. The pause is `Retry-After` (header, seconds →
 * ms, only when a positive number), otherwise exponential-ish backoff
 * `(attempt + 1) * 1000` (1s after the 1st 429, 2s after the 2nd). Any other
 * status (500, 404, …) or a network error is re-thrown immediately — no sleep,
 * no retry. Each retry is logged via `logger.warn` with attempt number and delay.
 */
export async function fetchBlobRaw(
  projectId: number,
  sha: string,
  opts?: FetchBlobRawOptions,
): Promise<Readable> {
  const maxRetries = opts?.maxRetries ?? 2;
  const sleep = opts?.sleep ?? defaultSleep;
  const projectName = opts?.projectName ?? String(projectId);
  const url = `/api/v4/projects/${projectId}/repository/blobs/${sha}/raw`;

  for (let attempt = 0; ; attempt++) {
    try {
      const resp = await axiosInstance.get<Readable>(url, { responseType: 'stream' });
      return resp.data;
    } catch (err) {
      // axios throws AxiosError on 4xx/5xx; detect 429 via err.response.status.
      const status = (err as { response?: { status?: number } } | null)?.response?.status;
      if (status !== 429 || attempt >= maxRetries) {
        throw err;
      }
      const header = (err as { response?: { headers?: Record<string, string | string[]> } } | null)
        ?.response?.headers?.['retry-after'];
      const retryAfterSec = Number(header);
      const delayMs =
        Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? retryAfterSec * 1000
          : (attempt + 1) * 1000;
      logger.warn(
        `Blob fetch rate-limited (429) for ${projectName} ${sha}: retry ${attempt + 1}/${maxRetries} after ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }
}
