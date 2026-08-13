/**
 * Lightweight identifier for a single GitLab project, used when the caller
 * wants to narrow a search to a specific subset of repositories (e.g. the
 * `selectedRepos` option of `findStrings` or the interactive picker).
 */
export type RepoInfo = {
  /** GitLab project ID. */
  id: number;
  /** Project name as returned by GitLab. Always non-null on the paths that build RepoInfo. */
  name: string;
};

export type SearchProjectsItem = {
  id: number,
  description: string | null,
  name: string | null,
  name_with_namespace: string | null,
  path: string | null,
  path_with_namespace: string | null,
  created_at: string | null,
  default_branch: string | null,
  tag_list: unknown[],
  topics: unknown[],
  ssh_url_to_repo: string | null,
  http_url_to_repo: string | null,
  web_url: string | null,
  readme_url: string | null,
  forks_count: number,
  avatar_url: unknown,
  star_count: number,
  last_activity_at: string | null,
  namespace: {
    id: number,
    name: string | null,
    path: string | null,
    kind: string | null,
    full_path: string | null,
    parent_id: number,
    avatar_url: unknown,
    web_url: string | null,
  }
}

export type GetRepositoryFile = {
  file_name: string,
  file_path: string,
  size: number,
  encoding: string,
  content_sha256: string,
  ref: string,
  blob_id: string,
  commit_id: string,
  last_commit_id: string,
  execute_filemode: boolean,
  content: string
}

export type Branch = {
  name: string,
  commit: {
    id: string,
    short_id: string,
    created_at: string,
    parent_ids: string[],
    title: string,
    message: string,
    author_name: string,
    author_email: string,
    authored_date: string,
    committer_name: string,
    committer_email: string,
    committed_date: string,
    trailers: Record<string, string>,
    extended_trailers: Record<string, string>,
    web_url: string,
  },
  merged: boolean,
  protected: boolean,
  developers_can_push: boolean,
  developers_can_merge: boolean,
  can_push: boolean,
  default: boolean,
  web_url: string,
}
