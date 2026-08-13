import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger.ts';

/**
 *
 * @param dirPath
 * @param fileName
 * @param fileContent
 *
 * @example
 * ```
 * // Использование
 * try {
 *   const savedPath = createDirAndSaveFileSync(
 *     './my-files/docs',
 *     'example.txt',
 *     'Привет, это содержимое файла!'
 *   );
 *   console.log(`Файл создан по пути: ${savedPath}`);
 * } catch (error) {
 *   console.error('Не удалось создать файл:', error);
 * }
 * ```
 */
export function createDirAndSaveFileSync(dirPath: string, fileName: string, fileContent: string): string {
  try {
    // Проверяем существование директории
    if (!fs.existsSync(dirPath)) {
      // Создаем директорию рекурсивно
      fs.mkdirSync(dirPath, { recursive: true });
      logger.debug(`Директория создана: ${dirPath}`);
    } else {
      logger.debug(`Директория уже существует: ${dirPath}`);
    }

    // Полный путь к файлу
    const filePath = path.join(dirPath, fileName);

    // Записываем файл
    fs.writeFileSync(filePath, fileContent, 'utf8');
    logger.debug(`Файл сохранен: ${filePath}`);

    return filePath;
  } catch (error) {
    logger.error(`Ошибка: ${(error as Error).message}`);
    throw error;
  }
}


