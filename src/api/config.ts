import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';

const env = dotenv.config({ path: path.resolve(process.cwd(), '.env') }).parsed as {
  PRIVATE_TOKEN: string,
  GITLAB_URL: string,
};

export const axiosInstance = axios.create({
  baseURL: env.GITLAB_URL,
  headers: {
    'PRIVATE-TOKEN': process.env.PRIVATE_TOKEN,
  },
});


/**
 * Извлекает текст тела ответа из AxiosError (если он есть) для подробного сообщения.
 */
export function axiosErrorBody(e: unknown): string {
  if (!axios.isAxiosError(e)) return '';
  const data = e.response?.data;
  if (data == null) return '';
  return ` ${typeof data === 'string' ? data : JSON.stringify(data)}`;
}
