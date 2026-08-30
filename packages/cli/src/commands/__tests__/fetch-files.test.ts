import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type {
  FetchFilesOptions,
  FetchedFile,
  FetchedRepo,
} from '@gitlab-analyzer/core';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  fetchFiles: vi.fn(),
  getAllProjects: vi.fn(),
}));

vi.mock('@gitlab-analyzer/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gitlab-analyzer/core')>();
  return {
    ...actual,
    fetchFiles: mocks.fetchFiles,
    loadConfig: mocks.loadConfig,
  };
});

vi.mock('@gitlab-analyzer/core/internal', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@gitlab-analyzer/core/internal')
  >();
  return {
    ...actual,
    getAllProjects: mocks.getAllProjects,
  };
});

import { runFetchFiles } from '../fetch-files.ts';
import type { FetchFilesCliOptions } from '../../utils/options.ts';

const TEST_GITLAB_URL = 'https://gitlab.example.com';
const TEST_PRIVATE_TOKEN = 'test-token-for-vitest';

const defaultConfig = () => ({
  defaults: {
    branch: 'develop',
    excludeRepos: [],
    fileExclude: [],
  },
});

const collectWriteCalls = (spy: ReturnType<typeof vi.spyOn>): string =>
  spy.mock.calls.map((c: readonly unknown[]) => String(c[0])).join('');

type FileSpec =
  | { path: string; status: 'fetched'; content: string }
  | { path: string; status: 'binary'; data: Buffer }
  | { path: string; status: 'large'; streamBytes: number }
  | { path: string; status: 'failed'; error: string };

type RepoSpec = {
  projectId: number;
  projectName: string;
  webUrl?: string | null;
  status?: FetchedRepo['status'];
  error?: string;
  files: FileSpec[];
};

/**
 * Drives the mocked core `fetchFiles`: walks the scenario list, calls the
 * CLI `saveFile` hook for every non-failed file, wires the returned `savedAs`
 * back into the FetchedFile, computes repo status/counters and fires
 * onRepoStart/onProgress — the same contract core implements.
 */
function mockRepos(specs: RepoSpec[]): void {
  mocks.fetchFiles.mockImplementation(async (opts: FetchFilesOptions) => {
    const repos: FetchedRepo[] = [];
    let done = 0;
    for (const spec of specs) {
      if (spec.status === 'error') {
        const error = spec.error ?? 'Request failed with status code 403';
        done++;
        opts.onProgress?.(done, specs.length, spec.projectName, error);
        repos.push({
          projectId: spec.projectId,
          projectName: spec.projectName,
          webUrl: spec.webUrl ?? null,
          branch: opts.branch,
          status: 'error',
          filesTotal: 0,
          filesFetched: 0,
          filesFailed: 0,
          error,
          truncated: false,
          files: [],
        });
        continue;
      }
      opts.onRepoStart?.(spec.projectName);
      const files: FetchedFile[] = [];
      for (const f of spec.files) {
        const base = {
          projectId: spec.projectId,
          repo: spec.projectName,
          branch: opts.branch,
          path: f.path,
        };
        if (f.status === 'failed') {
          files.push({
            ...base,
            bytes: null,
            status: 'failed',
            content: null,
            savedAs: null,
            error: f.error,
          });
          continue;
        }
        const data: Buffer | Readable =
          f.status === 'large'
            ? Readable.from([Buffer.alloc(f.streamBytes)])
            : f.status === 'binary'
              ? f.data
              : Buffer.from(f.content, 'utf-8');
        const bytes: number | null =
          f.status === 'large'
            ? null
            : f.status === 'binary'
              ? f.data.length
              : Buffer.byteLength(f.content, 'utf-8');
        const saveFile = opts.saveFile;
        if (!saveFile) {
          throw new Error('fetch-files must pass a saveFile hook');
        }
        const { savedAs } = await saveFile({ ...base, bytes, data, status: f.status });
        files.push({
          ...base,
          bytes,
          status: f.status,
          content: f.status === 'fetched' ? f.content : null,
          savedAs,
          error: null,
        });
      }
      const filesFailed = files.filter((x) => x.status === 'failed').length;
      const status =
        spec.status ??
        (files.length === 0 ? 'not-found' : filesFailed > 0 ? 'partial' : 'fetched');
      done++;
      opts.onProgress?.(done, specs.length, spec.projectName);
      repos.push({
        projectId: spec.projectId,
        projectName: spec.projectName,
        webUrl: spec.webUrl ?? null,
        branch: opts.branch,
        status,
        filesTotal: files.length,
        filesFetched: files.length - filesFailed,
        filesFailed,
        error: null,
        truncated: false,
        files,
      });
    }
    return { repos };
  });
}

describe('runFetchFiles (exported helper)', () => {
  let tmpDir: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    process.env.GITLAB_URL = TEST_GITLAB_URL;
    process.env.PRIVATE_TOKEN = TEST_PRIVATE_TOKEN;
    delete process.env.ENABLE_LOGS;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'fetch-files-'));
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    mocks.loadConfig.mockReset();
    mocks.fetchFiles.mockReset();
    mocks.getAllProjects.mockReset();
    mocks.loadConfig.mockResolvedValue(defaultConfig());
    mocks.getAllProjects.mockResolvedValue([
      { id: 1, name: 'alpha', description: null },
    ]);
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    // Windows: a just-closed createWriteStream handle can briefly keep the
    // dir busy — retry instead of failing the suite.
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('json: one repo → one <repo>.json + meta.json with the full meta shape', async () => {
    mockRepos([
      {
        projectId: 1,
        projectName: 'alpha',
        webUrl: 'https://gitlab.example.com/alpha',
        files: [{ path: 'src/a.ts', status: 'fetched', content: 'hello' }],
      },
    ]);

    const { resultsDir } = await runFetchFiles(['**/*.ts'], { output: tmpDir });

    expect(path.basename(resultsDir)).toMatch(
      /^fetch-files-results-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/,
    );
    expect(mocks.fetchFiles).toHaveBeenCalledWith(
      expect.objectContaining({ patterns: ['**/*.ts'] }),
    );

    const repoJson = JSON.parse(
      await readFile(path.join(resultsDir, 'alpha.json'), 'utf-8'),
    );
    expect(repoJson).toEqual({
      repo: 'alpha',
      projectId: 1,
      webUrl: 'https://gitlab.example.com/alpha',
      branch: 'develop',
      files: [{ path: 'src/a.ts', bytes: 5, content: 'hello' }],
    });

    const meta = JSON.parse(
      await readFile(path.join(resultsDir, 'meta.json'), 'utf-8'),
    );
    expect(Object.keys(meta).sort()).toEqual(
      ['branch', 'files', 'format', 'generatedAt', 'patterns', 'repos'].sort(),
    );
    expect(meta.format).toBe('json');
    expect(meta.patterns).toEqual(['**/*.ts']);
    expect(meta.branch).toBe('develop');
    expect(Object.keys(meta.repos[0]).sort()).toEqual(
      [
        'projectId',
        'projectName',
        'webUrl',
        'branch',
        'status',
        'branchExists',
        'filesTotal',
        'filesFetched',
        'filesFailed',
        'error',
      ].sort(),
    );
    expect(meta.repos[0]).toEqual({
      projectId: 1,
      projectName: 'alpha',
      webUrl: 'https://gitlab.example.com/alpha',
      branch: 'develop',
      status: 'fetched',
      branchExists: true,
      filesTotal: 1,
      filesFetched: 1,
      filesFailed: 0,
      error: null,
    });
    expect(Object.keys(meta.files[0]).sort()).toEqual(
      [
        'projectId',
        'repo',
        'branch',
        'path',
        'bytes',
        'storage',
        'savedAs',
        'status',
        'error',
      ].sort(),
    );
    expect(meta.files[0]).toEqual({
      projectId: 1,
      repo: 'alpha',
      branch: 'develop',
      path: 'src/a.ts',
      bytes: 5,
      storage: 'json',
      savedAs: 'alpha.json',
      status: 'fetched',
      error: null,
    });
  });

  it('json: repo-name collision → alpha.json + alpha-1.json + warn', async () => {
    mocks.getAllProjects.mockResolvedValue([
      { id: 1, name: 'alpha', description: null },
      { id: 2, name: 'alpha', description: null },
    ]);
    mockRepos([
      {
        projectId: 1,
        projectName: 'alpha',
        files: [{ path: 'a.ts', status: 'fetched', content: 'one' }],
      },
      {
        projectId: 2,
        projectName: 'alpha',
        files: [{ path: 'a.ts', status: 'fetched', content: 'two' }],
      },
    ]);

    const { resultsDir } = await runFetchFiles(['**/*.ts'], { output: tmpDir });

    expect(existsSync(path.join(resultsDir, 'alpha.json'))).toBe(true);
    expect(existsSync(path.join(resultsDir, 'alpha-1.json'))).toBe(true);
    expect(collectWriteCalls(stderrSpy)).toContain('alpha-1.json');
    expect(collectWriteCalls(stderrSpy)).toContain('уже занято');

    const meta = JSON.parse(
      await readFile(path.join(resultsDir, 'meta.json'), 'utf-8'),
    );
    expect(meta.files[0].savedAs).toBe('alpha.json');
    expect(meta.files[1].savedAs).toBe('alpha-1.json');
  });

  it('json: not-found repo → no json file for it, but meta has its repo entry', async () => {
    mockRepos([
      {
        projectId: 1,
        projectName: 'alpha',
        files: [{ path: 'a.ts', status: 'fetched', content: 'x' }],
      },
      { projectId: 2, projectName: 'beta', status: 'not-found', files: [] },
    ]);

    const { resultsDir } = await runFetchFiles(['**/*.ts'], { output: tmpDir });

    expect(existsSync(path.join(resultsDir, 'alpha.json'))).toBe(true);
    expect(existsSync(path.join(resultsDir, 'beta.json'))).toBe(false);
    const meta = JSON.parse(
      await readFile(path.join(resultsDir, 'meta.json'), 'utf-8'),
    );
    expect(meta.repos).toHaveLength(2);
    expect(meta.repos[1]).toEqual({
      projectId: 2,
      projectName: 'beta',
      webUrl: null,
      branch: 'develop',
      status: 'not-found',
      branchExists: true,
      filesTotal: 0,
      filesFetched: 0,
      filesFailed: 0,
      error: null,
    });
    expect(meta.files).toHaveLength(1);
  });

  it('json: binary file → <repo>/<path> on disk, content: null in json + warn', async () => {
    mockRepos([
      {
        projectId: 1,
        projectName: 'alpha',
        webUrl: 'https://gitlab.example.com/alpha',
        files: [
          { path: 'assets/logo.png', status: 'binary', data: Buffer.from([1, 2, 3]) },
          { path: 'src/a.ts', status: 'fetched', content: 'hi' },
        ],
      },
    ]);

    const { resultsDir } = await runFetchFiles(['**/*'], { output: tmpDir });

    const binaryPath = path.join(resultsDir, 'alpha', 'assets', 'logo.png');
    expect(existsSync(binaryPath)).toBe(true);
    expect(await readFile(binaryPath)).toEqual(Buffer.from([1, 2, 3]));
    expect(collectWriteCalls(stderrSpy)).toContain('Binary file — saved separately');

    const repoJson = JSON.parse(
      await readFile(path.join(resultsDir, 'alpha.json'), 'utf-8'),
    );
    expect(repoJson.files).toEqual([
      { path: 'assets/logo.png', bytes: 3, content: null },
      { path: 'src/a.ts', bytes: 2, content: 'hi' },
    ]);

    const meta = JSON.parse(
      await readFile(path.join(resultsDir, 'meta.json'), 'utf-8'),
    );
    expect(meta.files[0]).toMatchObject({
      path: 'assets/logo.png',
      status: 'binary',
      storage: 'file',
      savedAs: 'alpha/assets/logo.png',
      bytes: 3,
    });
    expect(meta.files[1]).toMatchObject({
      path: 'src/a.ts',
      status: 'fetched',
      storage: 'json',
      savedAs: 'alpha.json',
    });
  });

  it('ndjson: basename collisions → package-lock.json + package-lock-1.json + index lines without webUrl', async () => {
    mocks.getAllProjects.mockResolvedValue([
      { id: 1, name: 'alpha', description: null },
      { id: 2, name: 'beta', description: null },
    ]);
    mockRepos([
      {
        projectId: 1,
        projectName: 'alpha',
        webUrl: 'https://gitlab.example.com/alpha',
        files: [
          { path: 'pkg/package-lock.json', status: 'fetched', content: '{"a":1}' },
        ],
      },
      {
        projectId: 2,
        projectName: 'beta',
        webUrl: 'https://gitlab.example.com/beta',
        files: [{ path: 'package-lock.json', status: 'fetched', content: '{"b":2}' }],
      },
    ]);

    const { resultsDir } = await runFetchFiles(['**/package-lock.json'], {
      output: tmpDir,
      format: 'ndjson',
    });

    expect(existsSync(path.join(resultsDir, 'package-lock.json'))).toBe(true);
    expect(existsSync(path.join(resultsDir, 'package-lock-1.json'))).toBe(true);
    expect(
      await readFile(path.join(resultsDir, 'package-lock.json'), 'utf-8'),
    ).toBe('{"a":1}');
    expect(
      await readFile(path.join(resultsDir, 'package-lock-1.json'), 'utf-8'),
    ).toBe('{"b":2}');
    expect(collectWriteCalls(stderrSpy)).toContain('package-lock-1.json');

    const ndjsonRaw = await readFile(path.join(resultsDir, 'results.ndjson'), 'utf-8');
    expect(ndjsonRaw).not.toContain('webUrl');
    const lines = ndjsonRaw
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(Object.keys(lines[0]).sort()).toEqual(
      ['projectId', 'repo', 'branch', 'path', 'bytes', 'savedAs'].sort(),
    );
    expect(lines[0]).toMatchObject({
      projectId: 1,
      repo: 'alpha',
      branch: 'develop',
      path: 'pkg/package-lock.json',
      bytes: 7,
      savedAs: 'package-lock.json',
    });
    expect(lines[1]).toMatchObject({
      projectId: 2,
      repo: 'beta',
      branch: 'develop',
      path: 'package-lock.json',
      bytes: 7,
      savedAs: 'package-lock-1.json',
    });

    const meta = JSON.parse(
      await readFile(path.join(resultsDir, 'meta.json'), 'utf-8'),
    );
    expect(meta.format).toBe('ndjson');
    expect(meta.files[0]).toMatchObject({ storage: 'ndjson', savedAs: 'package-lock.json' });
    expect(meta.files[1]).toMatchObject({ storage: 'ndjson', savedAs: 'package-lock-1.json' });
  });

  it('ndjson: unsafe path → no file written, meta failed/"unsafe path", repo partial in meta', async () => {
    mockRepos([
      {
        projectId: 1,
        projectName: 'alpha',
        files: [{ path: 'a/../evil.ts', status: 'fetched', content: 'x' }],
      },
    ]);

    const { resultsDir } = await runFetchFiles(['**/*.ts'], {
      output: tmpDir,
      format: 'ndjson',
    });

    expect(existsSync(path.join(resultsDir, 'evil.ts'))).toBe(false);
    const listing = await readdir(resultsDir);
    expect(listing).not.toContain('evil.ts');
    expect(collectWriteCalls(stderrSpy)).toContain('unsafe path');

    const meta = JSON.parse(
      await readFile(path.join(resultsDir, 'meta.json'), 'utf-8'),
    );
    expect(meta.files[0]).toMatchObject({
      path: 'a/../evil.ts',
      status: 'failed',
      error: 'unsafe path',
      storage: null,
      savedAs: null,
    });
    expect(meta.repos[0].status).toBe('partial');
  });

  it('txt: embedded content + binary/large/failed placeholder lines', async () => {
    mockRepos([
      {
        projectId: 1,
        projectName: 'alpha',
        webUrl: 'https://gitlab.example.com/alpha',
        files: [
          { path: 'src/a.ts', status: 'fetched', content: 'console.log(1)' },
          { path: 'img.bin', status: 'binary', data: Buffer.from([9, 9]) },
          { path: 'big.bin', status: 'large', streamBytes: 2048 },
          { path: 'gone.ts', status: 'failed', error: 'boom' },
        ],
      },
    ]);

    const { resultsDir } = await runFetchFiles(['**/*'], {
      output: tmpDir,
      format: 'txt',
    });

    const txt = await readFile(path.join(resultsDir, 'results.txt'), 'utf-8');
    expect(txt).toContain('---- alpha');
    expect(txt).toContain('URL: https://gitlab.example.com/alpha');
    expect(txt).toContain('path: src/a.ts (14 bytes)');
    expect(txt).toContain('console.log(1)');
    expect(txt).toContain('[бинарный файл, сохранён отдельно: alpha/img.bin]');
    expect(txt).toContain('[файл > 10 МБ, сохранён отдельно: alpha/big.bin]');
    expect(txt).toContain('[файл не скачан: boom]');

    expect(existsSync(path.join(resultsDir, 'alpha', 'img.bin'))).toBe(true);
    const bigPath = path.join(resultsDir, 'alpha', 'big.bin');
    expect(existsSync(bigPath)).toBe(true);
    expect((await readFile(bigPath)).length).toBe(2048);

    const meta = JSON.parse(
      await readFile(path.join(resultsDir, 'meta.json'), 'utf-8'),
    );
    expect(meta.format).toBe('txt');
    expect(meta.files[0]).toMatchObject({
      status: 'fetched',
      storage: 'file',
      savedAs: 'results.txt',
    });
    expect(meta.files[1]).toMatchObject({
      status: 'binary',
      storage: 'file',
      savedAs: 'alpha/img.bin',
    });
    expect(meta.files[2]).toMatchObject({
      status: 'large',
      storage: 'file',
      savedAs: 'alpha/big.bin',
      bytes: 2048,
    });
    expect(meta.files[3]).toMatchObject({
      status: 'failed',
      storage: null,
      savedAs: null,
    });
  });

  it('txt: error/not-found repos (no files) produce no section in results.txt', async () => {
    mocks.getAllProjects.mockResolvedValue([
      { id: 1, name: 'alpha', description: null },
      { id: 2, name: 'beta', description: null },
      { id: 3, name: 'gamma', description: null },
    ]);
    mockRepos([
      {
        projectId: 1,
        projectName: 'alpha',
        webUrl: 'https://gitlab.example.com/alpha',
        files: [{ path: 'src/a.ts', status: 'fetched', content: 'keep me' }],
      },
      {
        projectId: 2,
        projectName: 'beta',
        status: 'error',
        error: 'Request failed with status code 403',
        files: [],
      },
      { projectId: 3, projectName: 'gamma', status: 'not-found', files: [] },
    ]);

    const { resultsDir } = await runFetchFiles(['**/*.ts'], {
      output: tmpDir,
      format: 'txt',
    });

    const txt = await readFile(path.join(resultsDir, 'results.txt'), 'utf-8');
    expect(txt).toContain('---- alpha (id: 1) ----');
    expect(txt).toContain('keep me');
    expect(txt).not.toContain('beta');
    expect(txt).not.toContain('gamma');
  });

  it('large: stream consumed, bytes counted, warn with MB, meta bytes not null', async () => {
    const streamBytes = 5 * 1024 * 1024;
    mockRepos([
      {
        projectId: 1,
        projectName: 'alpha',
        files: [{ path: 'big.bin', status: 'large', streamBytes }],
      },
    ]);

    const { resultsDir } = await runFetchFiles(['**/*'], { output: tmpDir });

    const meta = JSON.parse(
      await readFile(path.join(resultsDir, 'meta.json'), 'utf-8'),
    );
    expect(meta.files[0].bytes).toBe(streamBytes);
    expect(meta.files[0].status).toBe('large');
    expect(meta.files[0].storage).toBe('file');
    expect(meta.files[0].savedAs).toBe('alpha/big.bin');
    expect(collectWriteCalls(stderrSpy)).toContain('5.0 MB > 10 MB');
    expect(collectWriteCalls(stderrSpy)).toContain(
      'сохранён на диск, в отчёт не встроен',
    );

    const bigPath = path.join(resultsDir, 'alpha', 'big.bin');
    expect(existsSync(bigPath)).toBe(true);
    expect((await readFile(bigPath)).length).toBe(streamBytes);
  });

  it('meta: 403 tree error → branchExists: false', async () => {
    mockRepos([
      {
        projectId: 1,
        projectName: 'alpha',
        status: 'error',
        error: 'Request failed with status code 403',
        files: [],
      },
    ]);

    const { resultsDir } = await runFetchFiles(['**/*'], { output: tmpDir });

    const meta = JSON.parse(
      await readFile(path.join(resultsDir, 'meta.json'), 'utf-8'),
    );
    expect(meta.repos[0].status).toBe('error');
    expect(meta.repos[0].branchExists).toBe(false);
    expect(existsSync(path.join(resultsDir, 'alpha.json'))).toBe(false);
  });

  it('meta: 404 tree error → branchExists: false + branch-missing warn', async () => {
    mockRepos([
      {
        projectId: 1,
        projectName: 'alpha',
        status: 'error',
        error: 'Request failed with status code 404',
        files: [],
      },
    ]);

    const { resultsDir } = await runFetchFiles(['**/*'], { output: tmpDir });

    const meta = JSON.parse(
      await readFile(path.join(resultsDir, 'meta.json'), 'utf-8'),
    );
    expect(meta.repos[0].branchExists).toBe(false);
    expect(collectWriteCalls(stderrSpy)).toContain('вероятно, не существует');
  });

  it('zero-match: meta written, normal return, D17 warn on stderr', async () => {
    mockRepos([
      { projectId: 1, projectName: 'alpha', status: 'not-found', files: [] },
    ]);

    const { resultsDir } = await runFetchFiles(['nothing-matches'], {
      output: tmpDir,
    });

    const meta = JSON.parse(
      await readFile(path.join(resultsDir, 'meta.json'), 'utf-8'),
    );
    expect(meta.repos).toHaveLength(1);
    expect(meta.files).toHaveLength(0);
    expect(collectWriteCalls(stderrSpy)).toContain(
      'No files matched the patterns across 1 repositories.',
    );
  });

  it('-o <dir>: resultsDir is nested inside the output directory', async () => {
    mockRepos([
      {
        projectId: 1,
        projectName: 'alpha',
        files: [{ path: 'a.ts', status: 'fetched', content: 'x' }],
      },
    ]);
    const outDir = path.join(tmpDir, 'custom-out');
    await mkdir(outDir, { recursive: true });

    const { resultsDir } = await runFetchFiles(['**/*'], { output: outDir });

    expect(path.dirname(resultsDir)).toBe(outDir);
    expect(existsSync(resultsDir)).toBe(true);
    expect(path.basename(resultsDir)).toMatch(/^fetch-files-results-/);
  });

  it('summary line on stderr + stdout stays empty', async () => {
    mockRepos([
      {
        projectId: 1,
        projectName: 'alpha',
        files: [
          { path: 'a.ts', status: 'fetched', content: 'abc' },
          { path: 'b.ts', status: 'fetched', content: 'de' },
        ],
      },
    ]);

    const { resultsDir } = await runFetchFiles(['**/*.ts'], { output: tmpDir });

    const stderr = collectWriteCalls(stderrSpy);
    expect(stderr).toContain('✓ Fetched 2 files (1 repos), total 0.0 MB');
    expect(stderr).toContain(`meta: ${path.join(resultsDir, 'meta.json')}`);
    expect(collectWriteCalls(stdoutSpy)).toBe('');
  });

  it('missing required options → consolidated error', async () => {
    delete process.env.GITLAB_URL;
    delete process.env.PRIVATE_TOKEN;
    mocks.loadConfig.mockResolvedValue({});

    await expect(runFetchFiles([], {})).rejects.toThrow(
      /Cannot run fetch-files — missing required options:[\s\S]*gitlabUrl[\s\S]*PRIVATE_TOKEN[\s\S]*patterns/,
    );
  });

  it('metrics-file: run/repo/summary records with fetch-files per-repo fields', async () => {
    mockRepos([
      {
        projectId: 1,
        projectName: 'alpha',
        files: [
          { path: 'a.ts', status: 'fetched', content: 'abc' },
          { path: 'b.bin', status: 'binary', data: Buffer.from([1, 2, 3, 4]) },
        ],
      },
    ]);
    const metricsFile = path.join(tmpDir, 'metrics.ndjson');

    await runFetchFiles(['**/*'], { output: tmpDir, metricsFile });

    const raw = await readFile(metricsFile, 'utf-8');
    const lines = raw
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ t: 'run', exitReason: 'complete', filesTotal: 2 });
    expect(lines[1]).toMatchObject({
      t: 'repo',
      projectId: 1,
      projectName: 'alpha',
      filesFound: 2,
      filesFetched: 2,
      filesFailed: 0,
      bytesTotal: 7,
      error: null,
    });
    expect(typeof lines[1].totalMs).toBe('number');
    expect(lines[2]).toMatchObject({ t: 'summary', exitReason: 'complete', filesTotal: 2 });
  });
});
