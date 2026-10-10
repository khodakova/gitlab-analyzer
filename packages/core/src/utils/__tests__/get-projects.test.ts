import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getAllProjects } from '../get-projects.ts';
import { axiosInstance } from '../../api/config.ts';
import { configureLogger } from '../../utils/logger.ts';

/**
 * `getAllProjects` fills the `metrics` accumulator: listMs, pagesFetched
 * (actual number of page requests made) and reposFound. We stub the module
 * axios instance and return a `x-total-pages` header to drive pagination.
 */
describe('getAllProjects metrics accumulator', () => {
  let getSpy: ReturnType<typeof vi.spyOn>;

  const pageResponse = (items: unknown[], totalPages: number) =>
    ({
      data: items,
      headers: { 'x-total-pages': String(totalPages) },
    }) as never;

  beforeEach(() => {
    getSpy = vi.spyOn(axiosInstance, 'get').mockResolvedValue(
      pageResponse([{ id: 1, name: 'p1' }], 3),
    );
    configureLogger({ enabled: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fills listMs, pagesFetched and reposFound', async () => {
    // First page returns 1 project and declares 3 total pages.
    getSpy.mockImplementation((url: string) => {
      const projectId = url.includes('page=1') ? 'p1' : 'p2';
      return Promise.resolve(pageResponse([{ id: 1, name: projectId }], 3));
    });

    const metrics = { listMs: 0, pagesFetched: 0, reposFound: 0 };
    const projects = await getAllProjects('frontend', metrics);

    // First page (1) + pages 2..3 → 3 pages fetched.
    expect(metrics.pagesFetched).toBe(3);
    expect(metrics.reposFound).toBe(projects.length);
    expect(metrics.reposFound).toBeGreaterThanOrEqual(3);
    expect(metrics.listMs).toBeGreaterThanOrEqual(0);
  });

  it('counts a single page when x-total-pages is 1', async () => {
    getSpy.mockResolvedValue(pageResponse([{ id: 1, name: 'p1' }], 1));

    const metrics = { listMs: 0, pagesFetched: 0, reposFound: 0 };
    await getAllProjects(null, metrics);

    expect(metrics.pagesFetched).toBe(1);
    expect(metrics.reposFound).toBe(1);
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves metrics untouched when none provided', async () => {
    getSpy.mockResolvedValue(pageResponse([{ id: 1, name: 'p1' }], 1));
    const projects = await getAllProjects('x');
    expect(projects).toHaveLength(1);
  });

  it('builds the query with simple=false and statistics=true (size prioritization)', async () => {
    getSpy.mockResolvedValue(pageResponse([{ id: 1, name: 'p1' }], 1));

    await getAllProjects(null);

    const url = getSpy.mock.calls[0][0] as string;
    expect(url).toMatch(/simple=false/);
    expect(url).toMatch(/statistics=true/);
    // `simple: true` must have been dropped — otherwise GitLab truncates the
    // fields and omits the `statistics` block entirely.
    expect(url).not.toMatch(/simple=true/);
  });

  // ---------- Uncovered cases from docs/test-cases.md section 8 ----------

  describe('coverage gaps (docs/test-cases.md section 8)', () => {
    it('case 15: axios error WITHOUT response (network down) → silently returns [] (bug doc)', async () => {
      // DNS failure / connection refused produce axios errors with no
      // `response`. The catch branch returns [[], 0] — indistinguishable
      // from "the filter matched nothing". 401/404 (with response) throw.
      getSpy.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { isAxiosError: true }));

      const projects = await getAllProjects('frontend');

      expect(projects).toEqual([]);
    });

    it('case 15 (counterpart): axios error WITH response throws a rich Error', async () => {
      getSpy.mockRejectedValue(
        Object.assign(new Error('Request failed with status code 401'), {
          isAxiosError: true,
          response: { status: 401, statusText: 'Unauthorized' },
        }),
      );

      await expect(getAllProjects(null)).rejects.toThrow(/401 Unauthorized/);
    });

    it('case 16: page 2..N failure → repos of those pages silently lost, page still counted (bug doc)', async () => {
      getSpy.mockImplementation((url: string) => {
        // page=2 (and per_page=100!) — match the page param exactly.
        if (/[?&]page=1(&|$)/.test(url)) {
          return Promise.resolve(pageResponse([{ id: 1, name: 'p1' }], 2));
        }
        // Page 2 request fails → .catch(() => []) swallows it.
        return Promise.reject(new Error('page 2 blew up'));
      });

      const metrics = { listMs: 0, pagesFetched: 0, reposFound: 0 };
      const projects = await getAllProjects(null, metrics);

      // PIN (bug doc): only page-1 repos survive; page 2's data is lost with
      // no warning anywhere.
      expect(projects).toHaveLength(1);
      // The failed page still counts as "fetched".
      expect(metrics.pagesFetched).toBe(2);
      expect(metrics.reposFound).toBe(1);
    });

    it('case 49: string x-total-pages header drives pagination via coercion', async () => {
      let pages = 0;
      getSpy.mockImplementation((url: string) => {
        pages++;
        // header is always a string on the wire
        return Promise.resolve(
          pageResponse([{ id: pages, name: `p${pages}` }], Number(url.match(/page=(\d+)/)?.[1] ?? 1) === 1 ? 3 : 3),
        );
      });

      const metrics = { listMs: 0, pagesFetched: 0, reposFound: 0 };
      const projects = await getAllProjects(null, metrics);

      expect(projects).toHaveLength(3);
      expect(metrics.pagesFetched).toBe(3);
    });

    it('case 49: missing x-total-pages header → silently one page only', async () => {
      // No x-total-pages in the response headers at all → `2 <= undefined`
      // is false → pagination loop never fires. PIN: quiet single-page.
      getSpy.mockResolvedValue({
        data: [{ id: 1, name: 'p1' }],
        headers: {},
      } as never);

      const metrics = { listMs: 0, pagesFetched: 0, reposFound: 0 };
      const projects = await getAllProjects(null, metrics);

      expect(getSpy).toHaveBeenCalledTimes(1);
      expect(projects).toHaveLength(1);
      expect(metrics.pagesFetched).toBe(1);
    });
  });
});
