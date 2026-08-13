import { logger } from './logger.ts';
const fs = require('fs').promises;

export async function deleteFolderIfExists(path: string) {
  try {
    await fs.access(path);
    await fs.rm(path, { recursive: true, force: true });
    logger.debug(`Папка ${path} успешно удалена`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug(`Папка ${path} не существует`);
    } else {
      logger.error(`Ошибка при удалении папки: ${String(error)}`);
    }
  }
}
