import { getQueryString } from './get-query-string.ts';
import { axiosErrorBody, axiosInstance } from '../api/config.ts';
import { SearchProjectsItem } from '../types.ts';
import axios from 'axios';
import { red } from 'colorette';
import { logger } from './logger.ts';

async function getProjectsByNamespaceQuery(params: { search?: string | null, page?: number, perPage?: number }) {
  const query = getQueryString({
    search: params?.search || '',
    simple: true,
    search_namespaces: true,
    page: params.page,
    per_page: params?.perPage || 100,
    order_by: 'name',
    sort: 'asc',
    archived: false,
  });
  return axiosInstance.get<SearchProjectsItem[]>(`/api/v4/projects?${query}`);
}

export async function getAllProjects(search?: string | null) {
  const [firstPageResult, totalPages] = await getProjectsByNamespaceQuery({ page: 1, search })
    .then((res) => {
      const projects = res.data
      const totalPages = res.headers['x-total-pages'];
      return [projects, totalPages];
    })
    .catch((err) => {
      if (axios.isAxiosError(err) && err.response) {
        const errorText = `${err.response.status} ${err.response.statusText}${axiosErrorBody(err)}`;
        const message = `${red('При получении списка репозиториев возникла ошибка:')}\n${errorText}`
        throw new Error(message);
      }
      return [[], 0]
    });

  const restQueriesOnProjects: Promise<SearchProjectsItem[]>[] = [];

  for (let i = 2; i <= totalPages; i++) {
    restQueriesOnProjects.push(getProjectsByNamespaceQuery({ page: i, search })
      .then((res) => res.data)
      .catch(() => []));
  }

  const resultsOnRestPages = (await Promise.all(restQueriesOnProjects)).flat();

  const projects: SearchProjectsItem[] = [
    ...firstPageResult,
    ...resultsOnRestPages,
  ];

  logger.debug(`Найдено репозиториев: ${projects.length}`);

  return projects;
}
