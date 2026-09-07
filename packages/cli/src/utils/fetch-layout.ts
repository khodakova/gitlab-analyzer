/**
 * Pure path/layout helpers for the `fetch-files` command (D25).
 *
 * Rules for a path component / basename to be unsafe:
 * - equals `..`;
 * - contains any of the Windows forbidden characters `<>:"|?*`;
 * - ends with `.` or ` `;
 * - its stem (part before the first `.`), case-insensitively, is one of the
 *   Windows-reserved device names (CON, PRN, AUX, NUL, COM1..COM9, LPT1..LPT9).
 *
 * Empty components are NOT unsafe: double slashes are not a case the GitLab
 * tree API produces, so they are not validated.
 */

/** Windows-reserved device names, checked against the stem (before first `.`). */
const WINDOWS_RESERVED_STEMS: ReadonlySet<string> = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

const FORBIDDEN_CHARS = /[<>:"|?*]/;

function isUnsafeComponent(component: string): boolean {
  if (component === '..') {
    return true;
  }
  if (FORBIDDEN_CHARS.test(component)) {
    return true;
  }
  if (component.endsWith('.') || component.endsWith(' ')) {
    return true;
  }
  const dotIndex = component.indexOf('.');
  const stem = dotIndex === -1 ? component : component.slice(0, dotIndex);
  return WINDOWS_RESERVED_STEMS.has(stem.toUpperCase());
}

/** D25: ..-компонент, Windows-reserved stem, <>:"|?*, хвостовая точка/пробел. */
export function isUnsafeBasename(basename: string): boolean {
  return isUnsafeComponent(basename);
}

/** Валидация ПОЛНОГО пути: unsafe на любом компоненте → true. */
export function isUnsafeRepoPath(path: string): boolean {
  return path.split('/').some(isUnsafeComponent);
}

/**
 * `foo.lock.json` + занятые `foo.lock.json`, `foo.lock-1.json` → `foo.lock-2.json`.
 * Суффикс вставляется перед расширением; без расширения — в конец stem.
 * Возвращает минимальное свободное N ≥ 1.
 */
export function withCollisionSuffix(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) {
    return name;
  }
  const dotIndex = name.lastIndexOf('.');
  const stem = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  const ext = dotIndex > 0 ? name.slice(dotIndex) : '';
  for (let n = 1; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/** Windows-safe таймстемп для имени каталога: `2026-08-28T14-30-05` (локальное время). */
export function timestampDirName(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  );
}
