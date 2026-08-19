import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from './logger.ts';

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
 *     // Creating a single file
 *     const filePath = await FileManager.ensureDirAndSave(
 *       './projects/my-app/src/utils/helper.js',
 *       `function greet(name: string): string {\n  return 'Hello, ' + name + '!';\n}\n\nexport { greet };`
 *     );
 *
 *     // Creating multiple files
 *     const createdFiles = await FileManager.saveMultipleFiles('./config/app', {
 *       'settings.json': JSON.stringify({ version: '1.0.0' }, null, 2),
 *       'readme.txt': 'Application configuration',
 *       'backup.cfg': 'auto_backup=true\ninterval=3600'
 *     });
 *
 *     console.log('Created files:', createdFiles);
 *
 *   } catch (error) {
 *     console.error('Error:', error);
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
      // Get the directory from the file path
      const dir = path.dirname(filePath);

      // Create the directory if it does not exist
      await fs.mkdir(dir, { recursive: true });

      // Check whether the file exists if overwrite = false
      if (!overwrite) {
        try {
          await fs.access(filePath);
          throw new Error(`File already exists: ${filePath}`);
        } catch {
          // File does not exist - safe to create
        }
      }

      // Write the file
      await fs.writeFile(filePath, content, { encoding, mode, flag });
      logger.debug(`File saved successfully: ${filePath}`);

      return filePath;
    } catch (error) {
      logger.error(`Error saving file: ${(error as Error).message}`);
      throw error;
    }
  }

  // Create multiple files in one directory
  static async saveMultipleFiles(dirPath: string, files: Record<string, string | Buffer>): Promise<string[]> {
    try {
      // Create the directory
      await fs.mkdir(dirPath, { recursive: true });

      // Save all files
      const results: string[] = [];
      for (const [fileName, content] of Object.entries(files)) {
        const filePath = path.join(dirPath, fileName);
        await fs.writeFile(filePath, content, 'utf8');
        results.push(filePath);
        logger.debug(`File created: ${filePath}`);
      }

      return results;
    } catch (error) {
      logger.error(`Error creating files: ${String(error)}`);
      throw error;
    }
  }
}


