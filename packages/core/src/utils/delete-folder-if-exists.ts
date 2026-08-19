import { logger } from './logger.ts';
const fs = require('fs').promises;

export async function deleteFolderIfExists(path: string) {
  try {
    await fs.access(path);
    await fs.rm(path, { recursive: true, force: true });
    logger.debug(`Folder ${path} successfully deleted`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug(`Folder ${path} does not exist`);
    } else {
      logger.error(`Error deleting folder: ${String(error)}`);
    }
  }
}
