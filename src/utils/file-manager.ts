import * as fs from 'fs/promises';
import * as path from 'path';

interface SaveOptions {
  encoding?: BufferEncoding;
  mode?: number;
  flag?: string;
  overwrite?: boolean;
}

/**
 * @example
 * ```
 * try {
 *     // Создание одного файла
 *     const filePath = await FileManager.ensureDirAndSave(
 *       './projects/my-app/src/utils/helper.js',
 *       `function greet(name: string): string {\n  return 'Привет, ' + name + '!';\n}\n\nexport { greet };`
 *     );
 *
 *     // Создание нескольких файлов
 *     const createdFiles = await FileManager.saveMultipleFiles('./config/app', {
 *       'settings.json': JSON.stringify({ version: '1.0.0' }, null, 2),
 *       'readme.txt': 'Конфигурация приложения',
 *       'backup.cfg': 'auto_backup=true\ninterval=3600'
 *     });
 *
 *     console.log('Созданные файлы:', createdFiles);
 *
 *   } catch (error) {
 *     console.error('Ошибка:', error);
 *   }
 * ```
 */
export class FileManager {
  static async ensureDirAndSave(filePath: string, content: string | Buffer, options: SaveOptions = {}): Promise<string> {
    const {
      encoding = 'utf8',
      mode = 0o666,
      flag = 'w',
      overwrite = true
    } = options;

    try {
      // Получаем директорию из пути к файлу
      const dir = path.dirname(filePath);

      // Создаем директорию если не существует
      await fs.mkdir(dir, { recursive: true });

      // Проверяем существование файла если overwrite = false
      if (!overwrite) {
        try {
          await fs.access(filePath);
          throw new Error(`Файл уже существует: ${filePath}`);
        } catch {
          // Файл не существует - можно создавать
        }
      }

      // Записываем файл
      await fs.writeFile(filePath, content, { encoding, mode, flag });
      console.log(`Файл успешно сохранен: ${filePath}`);

      return filePath;
    } catch (error) {
      console.error('Ошибка при сохранении файла:', (error as Error).message);
      throw error;
    }
  }

  // Создание нескольких файлов в одной директории
  static async saveMultipleFiles(dirPath: string, files: Record<string, string | Buffer>): Promise<string[]> {
    try {
      // Создаем директорию
      await fs.mkdir(dirPath, { recursive: true });

      // Сохраняем все файлы
      const results: string[] = [];
      for (const [fileName, content] of Object.entries(files)) {
        const filePath = path.join(dirPath, fileName);
        await fs.writeFile(filePath, content, 'utf8');
        results.push(filePath);
        console.log(`Создан файл: ${filePath}`);
      }

      return results;
    } catch (error) {
      console.error('Ошибка при создании файлов:', error);
      throw error;
    }
  }
}


