import { configureLogger } from '@gitlab-analyzer/core';
import { axiosInstance } from '@gitlab-analyzer/core/internal';

/**
 * Shared API-access wiring for every subcommand: enable the central logger
 * and point the module-level `axiosInstance` at the resolved GitLab
 * URL/token.
 *
 * Extracted from `prepareApiAccess` (find-matches) so other commands
 * (e.g. `fetch-files`) can reuse it without inheriting find-matches'
 * `resolveOptions` — notably `FetchFilesCliOptions.format` is not assignable
 * to `FindMatchesCliOptions.format`, and a `resolved.output` resolution would
 * pull `commands.find-matches.output` as an output DIRECTORY for commands
 * that never write a report.
 */
export async function applyApiAccess(resolved: {
  gitlabUrl: string;
  privateToken: string;
  enableLogs: boolean;
  interactive: boolean;
}): Promise<void> {
  // Enable the central logger for the whole process: debug/API/recovery logs
  // are only printed when `--enable-logs` was resolved, OR when running
  // interactively (interactive mode needs the full log to drive the picker).
  // Must run before any API calls below so the debug lines they emit are
  // visible/hidden correctly.
  configureLogger({ enabled: resolved.enableLogs || resolved.interactive });

  // Propagate the resolved GitLab URL to the module-level axiosInstance so
  // HTTP requests go to the right host. Necessary when only `config.gitlab.url`
  // (not `GITLAB_URL` env) is set, since `axiosInstance` was created at module
  // load before resolution ran. When env already provides the URL,
  // `axiosInstance.defaults.baseURL` matches `resolved.gitlabUrl` and this
  // assignment is a no-op.
  axiosInstance.defaults.baseURL = resolved.gitlabUrl;
  // Propagate the resolved GitLab token to the module-level axiosInstance so
  // requests carry the effective token (CLI `--private-token` > PRIVATE_TOKEN
  // env). Resolution guarantees `resolved.privateToken` is non-empty.
  axiosInstance.defaults.headers['PRIVATE-TOKEN'] = resolved.privateToken;
}
