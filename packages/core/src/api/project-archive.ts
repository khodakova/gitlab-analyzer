import { axiosInstance } from './config.ts';
import { logger, formatDuration } from '../utils/logger.ts';

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Size of the Git repository in bytes (git object volume, incl. history).
 * Taken from `GET /api/v4/projects/:id → statistics.repository_size`.
 *
 * Returns `undefined` when the statistics cannot be obtained (no rights, repo
 * removed, API does not return it) or the size is unknown. Used only for
 * diagnosing repos that failed by timeout — not part of the report.
 */
export async function getProjectRepositorySize(projectId: number): Promise<number | undefined> {
  try {
    const resp = await axiosInstance.get<{
      statistics?: { repository_size?: number | null };
    }>(`/api/v4/projects/${projectId}`, {
      // Without statistics=true GitLab does not return the statistics block (it is expensive).
      params: { statistics: true },
      timeout: 15_000,
    });
    return resp.data.statistics?.repository_size ?? undefined;
  } catch {
    return undefined;
  }
}

export async function getProjectArchive(
  projectId: number,
  options?: {
    projectName?: string;
    branch?: string;
    /** Mutable accumulator, filled with the download duration (ms). */
    metrics?: { downloadMs: number };
  },
) {
  const projectName = options?.projectName ?? String(projectId);
  const branch = options?.branch;
  // Hoisted BEFORE the try so the catch path can safely write downloadMs (t0
  // is always defined even if the error is thrown synchronously before any
  // request starts).
  const t0 = Date.now();
  try {
    let lastLoggedPct = 0;
    const resp = await axiosInstance.get<Blob>(
      `/api/v4/projects/${projectId}/repository/archive.zip`,
      {
        responseType: 'arraybuffer',
        params: {
          sha: branch,
        },
        // signal: hard-aborts the request exactly at 60s. Bare axios (Node)
        // `timeout` does NOT abort a request to a server that opened a
        // connection but sends no data — "aborted" then only arrives after N
        // minutes from the external timeout. signal guarantees the timeout.
        signal: AbortSignal.timeout(60_000),
        onDownloadProgress: (e) => {
          if (!e.total) {
            return;
          }
          const pct = Math.floor((e.loaded / e.total) * 100);
          // Log progress only when crossing the next 25% — don't spam.
          if (pct >= lastLoggedPct + 25) {
            lastLoggedPct = pct;
            logger.debug(
              `Downloading ${projectName}: ${mb(e.loaded)} of ${mb(e.total)} (${pct}%) in ${formatDuration(Date.now() - t0)}`,
            );
          }
        },
      },
    );

    // Body size: with axios in Node `responseType:'arraybuffer'` yields a
    // Buffer, not an ArrayBuffer — account for both, otherwise the log shows 0.0 MB.
    const raw = resp.data as ArrayBuffer | { length?: number } | null;
    const bytes =
      raw instanceof ArrayBuffer
        ? raw.byteLength
        : typeof raw === 'object' && raw !== null && typeof (raw as { length?: number }).length === 'number'
          ? (raw as { length: number }).length
          : 0;
    // Final URL = request.responseURL, after all redirects. If the repo moved,
    // the final path is visible here — and it becomes clear that the request
    // followed a redirect.
    const finalUrl = (resp.request as { responseURL?: string } | undefined)?.responseURL ?? '-';
    logger.debug(`Archive ${projectName} downloaded: status=${resp.status}, ${mb(bytes)} in ${formatDuration(Date.now() - t0)}, url=${finalUrl}`);
    if (options?.metrics) {
      options.metrics.downloadMs = Date.now() - t0;
    }
    return resp.data;
  } catch (err) {
    // Per-project recovery: the archive for a single repo is unreachable
    // (archived / private / removed mid-scan, or the requested branch does
    // not exist). The repo is skipped and the scan continues, so this is NOT
    // an unconditional error — it's debug output gated by `--enable-logs` /
    // `--interactive`. The error message is re-thrown so the caller can
    // surface it (e.g. in report metadata `error` / `branchExists: false`).
    const message = err instanceof Error ? err.message : String(err);
    // For axios errors add the code and final URL — shows which URL the request
    // actually went to.
    const cfgUrl = (err as { config?: { url?: string } } | null)?.config?.url;
    // `AbortSignal.timeout` in axios gives ERR_CANCELED/'canceled' (same as a
    // manual abort). A timeout can only be told apart by the abort reason:
    // TimeoutError. Rewrite the message into something human-readable so that
    // both the report (error with logs off) and the debug log make it clear
    // this is a download timeout, not a plain "canceled".
    const isTimeout =
      (err as { cause?: { name?: string } | DOMException } | null)?.cause?.name === 'TimeoutError';
    const finalMessage = isTimeout
      ? `archive download timed out (60s)`
      : message;
    logger.warn(`Failed to fetch archive for project ${projectName} ${projectId}: ${finalMessage}${cfgUrl ? ` (url=${cfgUrl})` : ''}`);
    // Fill downloadMs on the failure path too — reflects wall-clock time spent
    // before the throw (typically the 60s timeout for a stuck download).
    if (options?.metrics) {
      options.metrics.downloadMs = Date.now() - t0;
    }
    throw isTimeout ? new Error(finalMessage) : err;
  }
}
