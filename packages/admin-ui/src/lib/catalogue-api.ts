/**
 * The two administration surfaces this workspace talks to, and the request helpers over them.
 *
 * Administration and publishing are different APIs on the same service: `/api/v1/admin` governs
 * repositories, players, policies and approvals, and `/api/v1/publisher` governs the catalogue's
 * content. The workspace needs both, so the publisher base is derived from the configured admin base
 * rather than asked for twice — one deployment that sets only one of them and gets a bundle pointing
 * at localhost is exactly the failure the derived default exists to prevent. It can still be set
 * explicitly where the two surfaces are not served together.
 */
import { adminApiRequest, AdminApiError, type AdminRequestOptions } from './api-client.js';

export const ADMIN_API_BASE = import.meta.env.VITE_ADMIN_API_BASE ?? 'http://localhost:3000/api/v1/admin';
export const PUBLISHER_API_BASE =
  import.meta.env.VITE_PUBLISHER_API_BASE ?? ADMIN_API_BASE.replace(/\/admin\/*$/, '/publisher');

export function admin<T>(path: string, options?: AdminRequestOptions): Promise<T> {
  return adminApiRequest<T>(ADMIN_API_BASE, path, options);
}

export function publisher<T>(path: string, options?: AdminRequestOptions): Promise<T> {
  return adminApiRequest<T>(PUBLISHER_API_BASE, path, options);
}

export function errorMessage(error: unknown): string {
  if (error instanceof AdminApiError) return error.problem.detail || error.problem.title;
  if (error instanceof Error) return error.message;
  return 'The request failed.';
}
