import { createHttp, type TokenProvider } from '../http';

export const GRAPH = 'https://graph.microsoft.com/v1.0';
export const GRAPH_SCOPES = ['Sites.ReadWrite.All', 'Files.ReadWrite.All', 'User.ReadBasic.All', 'GroupMember.Read.All'];
const SCOPE = 'https://graph.microsoft.com/.default';

/** Minimal Microsoft Graph client for lists, drive items, people and group membership. */
export function createGraphClient(getToken: TokenProvider) {
  const http = createHttp(getToken);
  return {
    get: <T>(path: string, init?: RequestInit) => http<T>(`${GRAPH}${path}`, { ...init, scope: SCOPE }),
    post: <T>(path: string, body: unknown) => http<T>(`${GRAPH}${path}`, { method: 'POST', body, scope: SCOPE }),
    patch: <T>(path: string, body: unknown, etag?: string) => http<T>(`${GRAPH}${path}`, { method: 'PATCH', body, scope: SCOPE, headers: etag ? { 'If-Match': etag } : undefined }),
    putContent: <T>(path: string, content: string, contentType = 'text/plain') => http<T>(`${GRAPH}${path}`, { method: 'PUT', body: new Blob([content], { type: contentType }), scope: SCOPE, headers: { 'Content-Type': contentType } }),
    /** Group display names the signed-in user belongs to (for approver roles). */
    async myGroups(): Promise<string[]> {
      const r = await http<{ value: { '@odata.type': string; displayName?: string }[] }>(`${GRAPH}/me/memberOf?$select=displayName`, { scope: SCOPE });
      return r.value.filter((g) => g['@odata.type'] === '#microsoft.graph.group').map((g) => g.displayName ?? '').filter(Boolean);
    },
    async searchPeople(q: string) {
      const r = await http<{ value: { id: string; displayName: string; mail: string }[] }>(`${GRAPH}/users?$search="displayName:${encodeURIComponent(q)}"&$select=id,displayName,mail&$top=10`, { scope: SCOPE, headers: { ConsistencyLevel: 'eventual' } });
      return r.value.map((u) => ({ id: u.id, displayName: u.displayName, email: u.mail }));
    },
  };
}
export type GraphClient = ReturnType<typeof createGraphClient>;
