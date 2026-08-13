import { axiosInstance } from './config.ts';
import { GetRepositoryFile } from '../types.ts';

export async function getFileContent<Res>(repoId: number, fileName: string, branch: string): Promise<Res | null> {
  const fileNameEncoded = encodeURIComponent(encodeURI(fileName))
  const res = await axiosInstance.get<GetRepositoryFile>(`/api/v4/projects/${repoId}/repository/files/${fileNameEncoded}?ref=${branch}`)
    .then((res) => res.data.blob_id)
    .then((blobId: string) => {
      return axiosInstance.get(`/api/v4/projects/${repoId}/repository/blobs/${blobId}/raw`)
    })
    .then((res) => res.data)
    .catch(() => null);
  return res;
}
