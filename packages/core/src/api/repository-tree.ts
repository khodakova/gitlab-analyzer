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

function nextPage(headers: unknown): number | undefined {
  let raw = (headers as Record<string, string | string[] | undefined> | undefined)?.['x-next-page'];
  if (Array.isArray(raw)) raw = raw[0];
  const page = raw ? Number(raw) : NaN;
  return Number.isNaN(page) ? undefined : page;
}

/**
 * Lists the full repository tree recursively via offset pagination.
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
  let truncated = false;

  // Offset pagination: GitLab 18.8.x never returns x-next-page-token for
  // /repository/tree (keyset token only inside the Link header), so following
  // that header silently stops after page 1
  let page = 1;
  do {
    const params: Record<string, string | number> = { recursive: 'true', per_page: 100, ref, page };
    const resp = await axiosInstance.get(url, { params });
    entries.push(...(resp.data as TreeEntry[]));
    const next = nextPage(resp.headers);
    if (next === undefined) break;
    page = next;
  } while (page <= MAX_TREE_PAGES);

  if (page > MAX_TREE_PAGES) {
    truncated = true;
    logger.warn(
      `listRepoTreeRecursive: reached MAX_TREE_PAGES (${MAX_TREE_PAGES}) and x-next-page is still present` +
        `${opts?.projectName ? ` for project ${opts.projectName}` : ''} — result truncated`,
    );
  }
  return { entries, truncated };
}
