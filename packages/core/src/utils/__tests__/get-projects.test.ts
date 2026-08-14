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
});
