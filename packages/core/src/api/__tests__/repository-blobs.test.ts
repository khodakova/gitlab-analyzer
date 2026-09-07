import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

/**
 * Hoisted module mock (same style as find-matches.test.ts): `vi.hoisted`
 * runs BEFORE `vi.mock`, so `axiosGetMock` is a real `vi.fn()` by the time
 * the factory captures it. The mock replaces the whole `./config.ts` module
 * so no real axios instance / .env loading happens.
 */
const { axiosGetMock } = vi.hoisted(() => ({
  axiosGetMock: vi.fn(),
}));

vi.mock('../config.ts', () => ({
  axiosInstance: { get: axiosGetMock },
}));

import { fetchBlobRaw } from '../repository-blobs.ts';

/** AxiosError-shaped 429 with optional Retry-After header (lowercased by axios). */
function rateLimited(headers: Record<string, string> = {}): Error {
  return Object.assign(new Error('Request failed with status code 429'), {
    isAxiosError: true,
    response: { status: 429, headers },
    config: {},
  });
}

/** AxiosError-shaped non-429 HTTP error. */
function serverError(status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, headers: {} },
    config: {},
  });
}

function streamResponse(): { status: number; data: Readable } {
  return { status: 200, data: Readable.from(['raw-blob-body']) };
}

describe('fetchBlobRaw', () => {
  beforeEach(() => {
    axiosGetMock.mockReset();
  });

  it('returns the stream on 200 and requests blobs/<sha>/raw with responseType stream', async () => {
    const resp = streamResponse();
    axiosGetMock.mockResolvedValueOnce(resp);

    const data = await fetchBlobRaw(42, 'abc123');

    expect(data).toBe(resp.data);
    expect(axiosGetMock).toHaveBeenCalledTimes(1);
    expect(axiosGetMock.mock.calls[0][0]).toBe('/api/v4/projects/42/repository/blobs/abc123/raw');
    expect(axiosGetMock.mock.calls[0][1]).toMatchObject({ responseType: 'stream' });
  });

  it('retries 429 twice with backoff 1000 then 2000 and succeeds on 3rd attempt', async () => {
    const resp = streamResponse();
    axiosGetMock
      .mockRejectedValueOnce(rateLimited())
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce(resp);
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const data = await fetchBlobRaw(42, 'abc123', { projectName: 'repo', sleep });

    expect(data).toBe(resp.data);
    expect(axiosGetMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
  });

  it('uses Retry-After seconds when it is a positive number', async () => {
    axiosGetMock
      .mockRejectedValueOnce(rateLimited({ 'retry-after': '5' }))
      .mockResolvedValueOnce(streamResponse());
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await fetchBlobRaw(42, 'abc123', { sleep });

    expect(axiosGetMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it('falls back to backoff when Retry-After is non-numeric', async () => {
    axiosGetMock
      .mockRejectedValueOnce(rateLimited({ 'retry-after': 'soon' }))
      .mockResolvedValueOnce(streamResponse());
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await fetchBlobRaw(42, 'abc123', { sleep });

    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('throws after maxRetries (default 2) 429s: 3 attempts total, sleep called twice', async () => {
    axiosGetMock.mockRejectedValue(rateLimited());
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(fetchBlobRaw(42, 'abc123', { sleep })).rejects.toThrow(
      'Request failed with status code 429',
    );

    expect(axiosGetMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
  });

  it('throws immediately on 500 without sleeping', async () => {
    axiosGetMock.mockRejectedValue(serverError(500));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(fetchBlobRaw(42, 'abc123', { sleep })).rejects.toThrow(
      'Request failed with status code 500',
    );

    expect(axiosGetMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('honours maxRetries override (0 = single attempt, no sleep)', async () => {
    axiosGetMock.mockRejectedValue(rateLimited());
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(fetchBlobRaw(42, 'abc123', { maxRetries: 0, sleep })).rejects.toThrow('429');

    expect(axiosGetMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
