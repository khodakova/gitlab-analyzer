import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
        const data: Buffer = f.status === 'binary' ? f.data : Buffer.from(f.content, 'utf-8');
        const bytes: number =
          f.status === 'binary' ? f.data.length : Buffer.byteLength(f.content, 'utf-8');
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

  it('json: one results.json with all repos + meta.json with the full meta shape', async () => {
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

    const listing = await readdir(resultsDir);
    expect(listing.sort()).toEqual(['meta.json', 'results.json']);

    const report = JSON.parse(
      await readFile(path.join(resultsDir, 'results.json'), 'utf-8'),
    );
    expect(report).toEqual([
      {
        repo: 'alpha',
        projectId: 1,
        webUrl: 'https://gitlab.example.com/alpha',
        branch: 'develop',
        files: [{ path: 'src/a.ts', bytes: 5, content: 'hello' }],
      },
    ]);

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
      savedAs: 'results.json',
      status: 'fetched',
      error: null,
    });
  });

  it('json: not-found repo is absent from results.json under found, present with files:[] under all', async () => {
    mockRepos([
      {
        projectId: 1,
        projectName: 'alpha',
        files: [{ path: 'a.ts', status: 'fetched', content: 'x' }],
      },
      { projectId: 2, projectName: 'beta', status: 'not-found', files: [] },
    ]);

    const found = await runFetchFiles(['**/*.ts'], { output: tmpDir, format: 'json' });
    let report = JSON.parse(
      await readFile(path.join(found.resultsDir, 'results.json'), 'utf-8'),
    );
    expect(report).toHaveLength(1);
    expect(report[0].repo).toBe('alpha');
    const meta = JSON.parse(
      await readFile(path.join(found.resultsDir, 'meta.json'), 'utf-8'),
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

    const all = await runFetchFiles(['**/*.ts'], {
      output: tmpDir,
      format: 'json',
      outputFilter: 'all',
    });
    report = JSON.parse(
      await readFile(path.join(all.resultsDir, 'results.json'), 'utf-8'),
    );
    expect(report).toHaveLength(2);
    expect(report[1]).toEqual({
      repo: 'beta',
      projectId: 2,
      webUrl: null,
      branch: 'develop',
      files: [],
    });
  });

  it('json: binary file → <repo>/<path> on disk, content: null + savedAs in results.json + warn', async () => {
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

    const report = JSON.parse(
      await readFile(path.join(resultsDir, 'results.json'), 'utf-8'),
    );
    expect(report).toHaveLength(1);
    expect(report[0].files).toEqual([
      { path: 'assets/logo.png', bytes: 3, content: null, savedAs: 'alpha/assets/logo.png' },
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
      savedAs: 'results.json',
    });
  });

  it('ndjson: one <projectName>.ndjson per repo, self-contained lines, no results.ndjson', async () => {
    mocks.getAllProjects.mockResolvedValue([
      { id: 1, name: 'alpha', description: null },
      { id: 2, name: 'alpha', description: null },
    ]);
    mockRepos([
      {
        projectId: 1,
        projectName: 'alpha',
        files: [
          { path: 'pkg.json', status: 'fetched', content: '{"n":1}' },
          { path: 'img/logo.png', status: 'binary', data: Buffer.from([0x00]) },
        ],
      },
      {
        projectId: 2,
        projectName: 'alpha',
        files: [{ path: 'pkg.json', status: 'fetched', content: '{"n":2}' }],
      },
    ]);

    const { resultsDir } = await runFetchFiles(['**/*'], {
      output: tmpDir,
      format: 'ndjson',
    });

    const listing = await readdir(resultsDir);
    // 'alpha' — каталог отдельного бинарника (единое правило <repo>/<path>, спека §5)
    expect(listing.sort()).toEqual(['alpha', 'alpha-1.ndjson', 'alpha.ndjson', 'meta.json']);
    expect(listing).not.toContain('results.ndjson');
    expect(collectWriteCalls(stderrSpy)).toContain('уже занято');

    const firstLines = (await readFile(path.join(resultsDir, 'alpha.ndjson'), 'utf-8'))
      .trim()
      .split('\n');
    expect(JSON.parse(firstLines[0])).toEqual({
      projectId: 1,
      repo: 'alpha',
      branch: 'develop',
      path: 'pkg.json',
      bytes: 7,
      content: '{"n":1}',
    });
    // binary line carries savedAs, content null (same repo, second line)
    expect(JSON.parse(firstLines[1])).toEqual({
      projectId: 1,
      repo: 'alpha',
      branch: 'develop',
      path: 'img/logo.png',
      bytes: 1,
      content: null,
      savedAs: 'alpha/img/logo.png',
    });
    // second repo's file in the collision-suffixed file
    const second = JSON.parse(
      await readFile(path.join(resultsDir, 'alpha-1.ndjson'), 'utf-8'),
    );
    expect(second).toEqual({
      projectId: 2,
      repo: 'alpha',
      branch: 'develop',
      path: 'pkg.json',
      bytes: 7,
      content: '{"n":2}',
    });

    const meta = JSON.parse(
      await readFile(path.join(resultsDir, 'meta.json'), 'utf-8'),
    );
    expect(meta.format).toBe('ndjson');
    expect(meta.files[0]).toMatchObject({ storage: 'ndjson', savedAs: 'alpha.ndjson' });
    expect(meta.files[1]).toMatchObject({ storage: 'file', savedAs: 'alpha/img/logo.png' });
    expect(meta.files[2]).toMatchObject({ storage: 'ndjson', savedAs: 'alpha-1.ndjson' });
  });

  it('ndjson: output-filter all writes an empty file for a zero-file repo', async () => {
    mockRepos([
      { projectId: 3, projectName: 'empty-repo', status: 'not-found', files: [] },
    ]);

    const { resultsDir } = await runFetchFiles(['**/*'], {
      output: tmpDir,
      format: 'ndjson',
      outputFilter: 'all',
    });

    const listing = await readdir(resultsDir);
    expect(listing).toContain('empty-repo.ndjson');
    expect(await readFile(path.join(resultsDir, 'empty-repo.ndjson'), 'utf-8')).toBe('');
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

    const listing = await readdir(resultsDir);
    expect(listing).toEqual(['meta.json']); // found: zero non-failed files → no artifact
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

  it('txt: embedded content + binary/failed placeholder lines', async () => {
    mockRepos([
      {
        projectId: 1,
        projectName: 'alpha',
        webUrl: 'https://gitlab.example.com/alpha',
        files: [
          { path: 'src/a.ts', status: 'fetched', content: 'console.log(1)' },
          { path: 'img.bin', status: 'binary', data: Buffer.from([9, 9]) },
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
    expect(txt).toContain('[файл не скачан: boom]');

    expect(existsSync(path.join(resultsDir, 'alpha', 'img.bin'))).toBe(true);

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

  it('txt: output-filter all renders header-only sections for zero-file repos', async () => {
    mockRepos([
      {
        projectId: 1,
        projectName: 'alpha',
        webUrl: 'https://gitlab.example.com/alpha',
        files: [{ path: 'a.txt', status: 'fetched', content: 'hi' }],
      },
      { projectId: 2, projectName: 'beta', status: 'not-found', files: [] },
    ]);

    const { resultsDir } = await runFetchFiles(['**/*'], {
      output: tmpDir,
      format: 'txt',
      outputFilter: 'all',
    });

    const txt = await readFile(path.join(resultsDir, 'results.txt'), 'utf-8');
    expect(txt).toContain('---- alpha (id: 1) ----');
    expect(txt).toContain('path: a.txt (2 bytes)');
    // zero-file repo under `all`: header (+URL) only, no file blocks
    expect(txt).toContain('---- beta (id: 2) ----');
    expect(txt).not.toContain('path: pkg.json');
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
