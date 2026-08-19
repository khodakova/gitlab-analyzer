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
 * // Usage
 * try {
 *   const savedPath = createDirAndSaveFileSync(
 *     './my-files/docs',
 *     'example.txt',
 *     'Hello, this is the file content!'
 *   );
 *   console.log(`File created at path: ${savedPath}`);
 * } catch (error) {
 *   console.error('Failed to create file:', error);
 * }
 * ```
 */
export function createDirAndSaveFileSync(dirPath: string, fileName: string, fileContent: string): string {
  try {
    // Check whether the directory exists
    if (!fs.existsSync(dirPath)) {
      // Create the directory recursively
      fs.mkdirSync(dirPath, { recursive: true });
      logger.debug(`Directory created: ${dirPath}`);
    } else {
      logger.debug(`Directory already exists: ${dirPath}`);
    }

    // Full path to the file
    const filePath = path.join(dirPath, fileName);

    // Write the file
    fs.writeFileSync(filePath, fileContent, 'utf8');
    logger.debug(`File saved: ${filePath}`);

    return filePath;
  } catch (error) {
    logger.error(`Error: ${(error as Error).message}`);
    throw error;
  }
}


