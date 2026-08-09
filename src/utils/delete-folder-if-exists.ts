const fs = require('fs').promises;

export async function deleteFolderIfExists(path: string) {
  try {
    await fs.access(path);
    await fs.rm(path, { recursive: true, force: true });
    console.log(`Папка ${path} успешно удалена`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(`Папка ${path} не существует`);
    } else {
      console.error('Ошибка при удалении папки:', error);
    }
  }
}
