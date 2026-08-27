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

/**
 * Reads a build-time setting, treating an empty value as unset.
 *
 * An image that declares `ENV VITE_PUBLISHER_API_BASE=${VITE_PUBLISHER_API_BASE}` for a build
 * argument nobody passed hands Vite an empty string, not an absent variable — and `??` falls back
 * only on the absent one. The publisher base is optional by design, so without this the documented
 * default deployment compiles a bundle whose publisher requests go to a path on the workspace's own
 * origin instead of the API, and the catalogue pages fail on every request.
 */
const setting = (value: string | undefined): string | undefined => (value && value.trim() !== '' ? value : undefined);

/**
 * The publisher surface beside a given administration surface. A base that does not end in `/admin`
 * cannot be derived from and must be configured explicitly.
 */
export function publisherBaseFor(adminBase: string): string {
  return adminBase.replace(/\/admin\/*$/, '/publisher');
}

export const ADMIN_API_BASE = setting(import.meta.env.VITE_ADMIN_API_BASE) ?? 'http://localhost:3000/api/v1/admin';
export const PUBLISHER_API_BASE = setting(import.meta.env.VITE_PUBLISHER_API_BASE) ?? publisherBaseFor(ADMIN_API_BASE);

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
