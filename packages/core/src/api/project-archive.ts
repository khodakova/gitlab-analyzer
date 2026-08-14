import { axiosInstance } from './config.ts';
import { logger, formatDuration } from '../utils/logger.ts';

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Размер Git-репозитория в байтах (объём git-объектов, вкл. историю).
 * Берётся из `GET /api/v4/projects/:id → statistics.repository_size`.
 *
 * Возвращает `undefined`, если статистику получить нельзя (нет прав, репо
 * удалено, API не отдаёт) или размер неизвестен. Используется только для
 * диагностики упавших по таймауту репо — не является частью отчёта.
 */
export async function getProjectRepositorySize(projectId: number): Promise<number | undefined> {
  try {
    const resp = await axiosInstance.get<{
      statistics?: { repository_size?: number | null };
    }>(`/api/v4/projects/${projectId}`, {
      // Без statistics=true GitLab не отдаёт блок statistics (он дорогой).
      params: { statistics: true },
      timeout: 15_000,
    });
    return resp.data.statistics?.repository_size ?? undefined;
  } catch {
    return undefined;
  }
}

export async function getProjectArchive(projectId: number, options?: { projectName?: string, branch?: string }) {
  const projectName = options?.projectName ?? String(projectId);
  const branch = options?.branch;
  try {
    const startedAt = Date.now();
    let lastLoggedPct = 0;
    const resp = await axiosInstance.get<Blob>(
      `/api/v4/projects/${projectId}/repository/archive.zip`,
      {
        responseType: 'arraybuffer',
        params: {
          sha: branch,
        },
        // signal: жёстко обрывает запрос ровно через 60с. Голый `timeout`
        // у axios (Node) НЕ прерывает запрос к серверу, который открыл
        // соединение, но не отдаёт данные — «aborted» тогда приходит только
        // через N минут от внешнего таймаута. signal гарантирует таймаут.
        signal: AbortSignal.timeout(60_000),
        onDownloadProgress: (e) => {
          if (!e.total) {
            return;
          }
          const pct = Math.floor((e.loaded / e.total) * 100);
          // Логируем прогресс только при пересечении очередных 25% — не засираем.
          if (pct >= lastLoggedPct + 25) {
            lastLoggedPct = pct;
            logger.debug(
              `Загрузка ${projectName}: ${mb(e.loaded)} из ${mb(e.total)} (${pct}%) за ${formatDuration(Date.now() - startedAt)}`,
            );
          }
        },
      },
    );

    // Размер тела: у axios в Node `responseType:'arraybuffer'` даёт Buffer,
    // а не ArrayBuffer — учитываем оба варианта, иначе лог покажет 0.0 MB.
    const raw = resp.data as ArrayBuffer | { length?: number } | null;
    const bytes =
      raw instanceof ArrayBuffer
        ? raw.byteLength
        : typeof raw === 'object' && raw !== null && typeof (raw as { length?: number }).length === 'number'
          ? (raw as { length: number }).length
          : 0;
    // Итоговый URL = request.responseURL, после всех редиректов. Если репо
    // переехало, тут будет видно конечный путь — и будет понятно, что запрос
    // следовал редиректу.
    const finalUrl = (resp.request as { responseURL?: string } | undefined)?.responseURL ?? '-';
    logger.debug(`Архив ${projectName} скачан: статус=${resp.status}, ${mb(bytes)} за ${formatDuration(Date.now() - startedAt)}, url=${finalUrl}`);
    return resp.data;
  } catch (err) {
    // Per-project recovery: the archive for a single repo is unreachable
    // (archived / private / removed mid-scan, or the requested branch does
    // not exist). The repo is skipped and the scan continues, so this is NOT
    // an unconditional error — it's debug output gated by `--enable-logs` /
    // `--interactive`. The error message is re-thrown so the caller can
    // surface it (e.g. in report metadata `error` / `branchExists: false`).
    const message = err instanceof Error ? err.message : String(err);
    // Для axios-ошибок добавим code и итоговый URL — покажет, на какой URL
    // реально ушёл запрос.
    const cfgUrl = (err as { config?: { url?: string } } | null)?.config?.url;
    // `AbortSignal.timeout` в axios даёт ERR_CANCELED/'canceled' (то же, что
    // ручной abort). Отличить таймаут можно только по причине abort:
    // TimeoutError. Переписываем сообщение в человекочитаемое, чтобы и в
    // отчёте (error при выключенных логах), и в debug-логе было ясно, что это
    // таймаут скачивания, а не просто «отменено».
    const isTimeout =
      (err as { cause?: { name?: string } | DOMException } | null)?.cause?.name === 'TimeoutError';
    const finalMessage = isTimeout
      ? `превышен таймаут скачивания архива (60с)`
      : message;
    logger.warn(`Не удалось получить архив по проекту ${projectName} ${projectId}: ${finalMessage}${cfgUrl ? ` (url=${cfgUrl})` : ''}`);
    throw isTimeout ? new Error(finalMessage) : err;
  }
}
