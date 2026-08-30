import { axiosInstance } from './config.ts';
import { logger } from '../utils/logger.ts';

/** One entry of the GitLab repository tree API. */
export type TreeEntry = { id: string; name: string; type: 'blob' | 'tree'; path: string; mode: string };
/** Result of {@link listRepoTreeRecursive}: all fetched entries plus whether the walk hit the guard. */
export type TreeListResult = { entries: TreeEntry[]; truncated: boolean };

/** Safety cap on pages fetched (D24): 100 pages × 100 entries. */
const MAX_TREE_PAGES = 100;

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

function nextPageToken(headers: unknown): string | undefined {
  const raw = (headers as Record<string, string | string[] | undefined> | undefined)?.['x-next-page-token'];
  if (Array.isArray(raw)) return raw[0];
  return raw || undefined;
}

/**
 * Lists the full repository tree recursively via keyset pagination.
 * HTTP errors (404/403/...) are propagated to the caller (T4 normalizes them
 * into a repo status).
 */
export async function listRepoTreeRecursive(
  projectId: number,
  ref: string,
  opts?: { projectName?: string },
): Promise<TreeListResult> {
  const url = `/api/v4/projects/${projectId}/repository/tree`;
  const entries: TreeEntry[] = [];
  const seenTokens = new Set<string>();
  let truncated = false;

  let pageToken: string | undefined;
  let pages = 0;
  do {
    const params: Record<string, string | number> = { recursive: 'true', per_page: 100, pagination: 'keyset', ref };
    if (pageToken !== undefined) params.page_token = pageToken;
    const resp = await axiosInstance.get(url, { params });
    entries.push(...(resp.data as TreeEntry[]));
    pages++;
    const next = nextPageToken(resp.headers);
    if (next === undefined) {
      pageToken = undefined;
      break;
    }
    if (seenTokens.has(next)) {
      truncated = true;
      logger.warn(
        `listRepoTreeRecursive: pagination loop detected (repeated page_token ${next}) after ${pages} page(s)` +
          `${opts?.projectName ? ` for project ${opts.projectName}` : ''} — result truncated`,
      );
      break;
    }
    seenTokens.add(next);
    pageToken = next;
  } while (pages < MAX_TREE_PAGES);

  if (truncated === false && pages === MAX_TREE_PAGES && pageToken !== undefined) {
    truncated = true;
    logger.warn(
      `listRepoTreeRecursive: reached MAX_TREE_PAGES (${MAX_TREE_PAGES}) and x-next-page-token is still present` +
        `${opts?.projectName ? ` for project ${opts.projectName}` : ''} — result truncated`,
    );
  }
  return { entries, truncated };
}
