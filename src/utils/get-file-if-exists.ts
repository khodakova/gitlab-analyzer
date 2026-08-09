import * as fs from 'fs';

export function getFileIfExists(dirPath: string) {
  let res = null

  if (fs.existsSync(dirPath)) {
    res = fs.readFileSync(dirPath, 'utf8');
  }

  return res;
}
