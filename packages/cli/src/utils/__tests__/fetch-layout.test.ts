import { describe, it, expect } from 'vitest';
import {
  isUnsafeBasename,
  isUnsafeRepoPath,
  withCollisionSuffix,
  timestampDirName,
} from '../fetch-layout.ts';

describe('isUnsafeBasename', () => {
  it('flags the .. component as unsafe', () => {
    expect(isUnsafeBasename('..')).toBe(true);
  });

  it('flags Windows-reserved stems with and without extension', () => {
    expect(isUnsafeBasename('CON.json')).toBe(true);
    expect(isUnsafeBasename('CON')).toBe(true);
    expect(isUnsafeBasename('con.txt')).toBe(true);
    expect(isUnsafeBasename('AUX')).toBe(true);
    expect(isUnsafeBasename('PRN.tar.gz')).toBe(true);
    expect(isUnsafeBasename('NUL')).toBe(true);
    expect(isUnsafeBasename('COM1')).toBe(true);
    expect(isUnsafeBasename('com9.log')).toBe(true);
    expect(isUnsafeBasename('LPT9')).toBe(true);
    expect(isUnsafeBasename('lpt1.txt')).toBe(true);
  });

  it('treats COM0 and non-reserved stems as safe', () => {
    expect(isUnsafeBasename('COM0')).toBe(false);
    expect(isUnsafeBasename('COM10')).toBe(false);
    expect(isUnsafeBasename('CONST.ts')).toBe(false);
    expect(isUnsafeBasename('content.md')).toBe(false);
  });

  it('flags names containing Windows forbidden characters', () => {
    expect(isUnsafeBasename('a<b.json')).toBe(true);
    expect(isUnsafeBasename('a>b.json')).toBe(true);
    expect(isUnsafeBasename('a:b.json')).toBe(true);
    expect(isUnsafeBasename('a"b.json')).toBe(true);
    expect(isUnsafeBasename('a|b.json')).toBe(true);
    expect(isUnsafeBasename('a?b.json')).toBe(true);
    expect(isUnsafeBasename('a*b.json')).toBe(true);
  });

  it('flags trailing dot and trailing space', () => {
    expect(isUnsafeBasename('file.')).toBe(true);
    expect(isUnsafeBasename('file ')).toBe(true);
  });

  it('treats normal names as safe', () => {
    expect(isUnsafeBasename('index.ts')).toBe(false);
    expect(isUnsafeBasename('.gitignore')).toBe(false);
    expect(isUnsafeBasename('package-lock.json')).toBe(false);
    expect(isUnsafeBasename('a b.c')).toBe(false);
  });
});

describe('isUnsafeRepoPath', () => {
  it('accepts normal paths', () => {
    expect(isUnsafeRepoPath('src/index.ts')).toBe(false);
    expect(isUnsafeRepoPath('docs/README.md')).toBe(false);
    expect(isUnsafeRepoPath('a b/c.d')).toBe(false);
  });

  it('rejects a path with a .. component anywhere', () => {
    expect(isUnsafeRepoPath('src/../etc/passwd')).toBe(true);
    expect(isUnsafeRepoPath('../secret')).toBe(true);
  });

  it('rejects a path with an unsafe component', () => {
    expect(isUnsafeRepoPath('src/CON.json')).toBe(true);
    expect(isUnsafeRepoPath('lib/a<b.ts')).toBe(true);
    expect(isUnsafeRepoPath('lib/trailing. ')).toBe(true);
  });

  it('ignores empty components (double slashes)', () => {
    expect(isUnsafeRepoPath('src//index.ts')).toBe(false);
    expect(isUnsafeRepoPath('')).toBe(false);
  });

  it('does not reject safe multi-component names', () => {
    expect(isUnsafeRepoPath('packages/CONST.ts/src/main.ts')).toBe(false);
  });
});

describe('withCollisionSuffix', () => {
  it('returns the base name when nothing is taken', () => {
    expect(withCollisionSuffix('report.json', new Set())).toBe('report.json');
  });

  it('appends -1 when the base name is taken', () => {
    expect(withCollisionSuffix('report.json', new Set(['report.json']))).toBe(
      'report-1.json',
    );
  });

  it('finds the smallest free N and skips over taken suffixes', () => {
    expect(
      withCollisionSuffix(
        'package-lock.json',
        new Set(['package-lock.json', 'package-lock-1.json']),
      ),
    ).toBe('package-lock-2.json');
  });

  it('fills a gap when a lower N is free', () => {
    expect(
      withCollisionSuffix('a.txt', new Set(['a.txt', 'a-2.txt'])),
    ).toBe('a-1.txt');
  });

  it('appends the suffix to the end when there is no extension', () => {
    expect(withCollisionSuffix('Makefile', new Set(['Makefile']))).toBe(
      'Makefile-1',
    );
    expect(
      withCollisionSuffix('Makefile', new Set(['Makefile', 'Makefile-1'])),
    ).toBe('Makefile-2');
  });

  it('inserts the suffix before the last extension only', () => {
    expect(
      withCollisionSuffix('foo.lock.json', new Set(['foo.lock.json', 'foo.lock-1.json'])),
    ).toBe('foo.lock-2.json');
  });
});

describe('timestampDirName', () => {
  it('formats a local date as YYYY-MM-DDTHH-MM-SS', () => {
    // Local-time constructor: August 28 2026, 14:30:05.
    expect(timestampDirName(new Date(2026, 7, 28, 14, 30, 5))).toBe(
      '2026-08-28T14-30-05',
    );
  });

  it('zero-pads single-digit fields', () => {
    expect(timestampDirName(new Date(2026, 0, 2, 3, 4, 5))).toBe(
      '2026-01-02T03-04-05',
    );
  });

  it('contains no colons (Windows-safe)', () => {
    expect(timestampDirName(new Date(2026, 7, 28, 14, 30, 5))).not.toContain(':');
  });

  it('defaults to the current time in the same shape', () => {
    expect(timestampDirName()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  });
});
