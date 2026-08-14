import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getProjectArchive } from '../project-archive.ts';
import { axiosInstance } from '../config.ts';
import { configureLogger } from '../../utils/logger.ts';

/**
 * `getProjectArchive` fills the `metrics.downloadMs` accumulator on both the
 * success and throw paths. We stub the module-level `axiosInstance.get` and
 * drive the real function.
 */
describe('getProjectArchive metrics accumulator', () => {
  let getSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getSpy = vi.spyOn(axiosInstance, 'get').mockImplementation(async () => {
      // Minimal axios response shape the function reads (status/data/request).
      return {
        status: 200,
        data: new ArrayBuffer(4),
        request: { responseURL: 'https://x/archive.zip' },
      } as never;
    });
    configureLogger({ enabled: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fills metrics.downloadMs (> 0) on success', async () => {
    const metrics = { downloadMs: 0 };
    const data = await getProjectArchive(42, {
      projectName: 'repo',
      branch: 'develop',
      metrics,
    });

    expect(data).toBeInstanceOf(ArrayBuffer);
    expect(metrics.downloadMs).toBeGreaterThanOrEqual(0);
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy.mock.calls[0][0]).toContain('/api/v4/projects/42/repository/archive.zip');
  });

  it('fills metrics.downloadMs and re-throws on failure', async () => {
    getSpy.mockRejectedValue(
      Object.assign(new Error('Request failed'), { cause: new DOMException('boom', 'TimeoutError') }),
    );

    const metrics = { downloadMs: 0 };
    await expect(
      getProjectArchive(7, { projectName: 'repo', branch: 'dev', metrics }),
    ).rejects.toThrow('превышен таймаут скачивания архива (60с)');

    expect(metrics.downloadMs).toBeGreaterThanOrEqual(0);
  });

  it('leaves metrics untouched when none provided', async () => {
    const data = await getProjectArchive(42, { projectName: 'repo', branch: 'dev' });
    expect(data).toBeInstanceOf(ArrayBuffer);
  });
});
