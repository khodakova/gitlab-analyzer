import axios, { type AxiosInstance } from 'axios';
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

/**
 * Process-wide singleton.
 *
 * tsup bundles this module into BOTH dist entries (`index` and `internal`;
 * `splitting: false` is required for CJS), so one process ends up with TWO
 * axiosInstances: the CLI wires api access (baseURL/token) via `internal`
 * (`applyApiAccess`), while the commands make requests via `index`. Without
 * the singleton the wiring silently misses the second instance — with no
 * `.env` in cwd that means `baseURL: undefined` → "Invalid URL" on every
 * request not going through `internal` (list fetches worked, per-repo
 * requests failed). The global slot makes all bundles share one instance
 * regardless of entry point / module format.
 */
const globalSlot = globalThis as typeof globalThis & {
  __gitlabAnalyzerAxiosInstance?: AxiosInstance,
};

export const axiosInstance: AxiosInstance = (globalSlot.__gitlabAnalyzerAxiosInstance ??=
  axios.create({
    baseURL: env.GITLAB_URL,
    headers: {
      'PRIVATE-TOKEN': process.env.PRIVATE_TOKEN,
    },
  }));


/**
 * Extracts the response body text from an AxiosError (if present) for a detailed message.
 */
export function axiosErrorBody(e: unknown): string {
  if (!axios.isAxiosError(e)) return '';
  const data = e.response?.data;
  if (data == null) return '';
  return ` ${typeof data === 'string' ? data : JSON.stringify(data)}`;
}
