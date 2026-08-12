import Enquirer from 'enquirer';
import type { RepoInfo } from '../types.ts';

/**
 * Minimal structural type for the `multiselect` question we pass to enquirer.
 *
 * enquirer's own `index.d.ts` does not export `ArrayPromptOptions` and omits
 * the runtime-supported `limit` option from it, so we declare the exact shape
 * here. It stays assignable to `Enquirer.prompt`'s `PromptOptions` union (the
 * `member ? ArrayPromptOptions` arm matches `type: 'multiselect'`), and the
 * extra `limit` property is fine because assignability from a variable with an
 * explicit type performs no excess-property check (it is not a fresh literal).
 */
type MultiselectOptions = {
  type: 'multiselect';
  name: string;
  message: string;
  choices: Array<{ name: string; enabled: boolean }>;
  limit: number;
};

/**
 * A function that asks the user to pick a subset of repositories.
 *
 * Injected so tests can substitute a fake without opening a real TTY. The
 * default {@link enquirerRepoSelect} renders an `enquirer` `multiselect`
 * (all repos preselected; space toggles one; Enter confirms) and returns the
 * chosen `RepoInfo` entries.
 */
export type RepoSelectPrompt = (repos: readonly RepoInfo[]) => Promise<RepoInfo[]>;

/**
 * Default prompt implementation backed by `enquirer`'s `multiselect`.
 *
 * @param repos - Repositories to choose from (already filtered by `excludeRepos`
 *   upstream — see `cli.ts`). Every repo starts selected.
 * @returns The selected subset of `repos`.
 */
export const enquirerRepoSelect: RepoSelectPrompt = async (repos) => {
  // `Enquirer.prompt({ ... })` with a single question object resolves to
  // `{ [name]: value }` (an object keyed by the question `name`), and a
  // `multiselect` resolves to the array of SELECTED CHOICE NAMES (not the
  // choice `value`). So we read `answers.repos` (the `string[]` of names)
  // and map them back to the full `RepoInfo` objects from `repos`.
  const options: MultiselectOptions = {
    type: 'multiselect',
    name: 'repos',
    message:
      'Выберите репозитории, по которым будет выполнен поиск (пробел — отметить/снять, Enter — подтвердить)',
    choices: repos.map((repo) => ({
      name: repo.name,
      enabled: true,
    })),
    limit: 10,
  };
  const answers = await Enquirer.prompt<{ repos: string[] }>(options);

  const selectedNames = answers.repos;
  if (!Array.isArray(selectedNames)) {
    return [];
  }
  const byName = new Map(repos.map((repo) => [repo.name, repo]));
  return selectedNames
    .map((name) => byName.get(name))
    .filter((repo): repo is RepoInfo => repo !== undefined);
};

/**
 * Ask the user to pick a subset of repositories, calling {@link prompt}
 * (defaults to {@link enquirerRepoSelect}) with the full list.
 *
 * Pure — no console output, no `process.exit`. Return `[]` when the user
 * selects nothing; the caller decides how to handle that (see `cli.ts`).
 *
 * @param repos - Repositories to choose from.
 * @param prompt - Prompt function; only injected in tests.
 */
export async function repoSelect(
  repos: readonly RepoInfo[],
  prompt: RepoSelectPrompt = enquirerRepoSelect,
): Promise<RepoInfo[]> {
  return prompt(repos);
}
