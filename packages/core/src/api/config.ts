import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';

const env = dotenv.config({
  path: path.resolve(process.cwd(), '.env'),
  // dotenv v17 prints "injected env (N) from .env" to the console by default.
  // Suppress it so the CLI output stays clean (all output is governed by our
  // own logger / report helpers, not by dotenv's own chatter).
  quiet: true,
}).parsed as {
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
 * Extracts the response body text from an AxiosError (if present) for a detailed message.
 */
export function axiosErrorBody(e: unknown): string {
  if (!axios.isAxiosError(e)) return '';
  const data = e.response?.data;
  if (data == null) return '';
  return ` ${typeof data === 'string' ? data : JSON.stringify(data)}`;
}
