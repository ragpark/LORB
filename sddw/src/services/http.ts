import { uid } from '@/domain/ids';

export type TokenProvider = (scope: string) => Promise<string>;

export interface HttpOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  scope?: string;
  retries?: number;
}

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly body: unknown, message?: string) { super(message ?? `HTTP ${status}`); this.name = 'HttpError'; }
}

/**
 * fetch wrapper adding: bearer token per scope, correlation id, JSON handling,
 * exponential back-off on 429/5xx (max `retries`, default 4).
 */
export function createHttp(getToken: TokenProvider) {
  return async function http<T>(url: string, opts: HttpOptions = {}): Promise<T> {
    const { body, scope, retries = 4, headers, ...rest } = opts;
    const h = new Headers(headers);
    h.set('Accept', 'application/json');
    h.set('x-correlation-id', h.get('x-correlation-id') ?? uid('corr'));
    if (scope) h.set('Authorization', `Bearer ${await getToken(scope)}`);
    if (body !== undefined && !(body instanceof Blob) && typeof body !== 'string') h.set('Content-Type', 'application/json');
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { ...rest, headers: h, body: body === undefined ? undefined : body instanceof Blob || typeof body === 'string' ? body : JSON.stringify(body) });
      if (res.ok) return res.status === 204 ? (undefined as T) : ((await res.text()).length ? await res.clone().json() : (undefined as T));
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= retries) throw new HttpError(res.status, await safeJson(res), res.statusText);
      const retryAfter = Number(res.headers.get('Retry-After'));
      await new Promise((r) => setTimeout(r, retryAfter ? retryAfter * 1000 : 500 * 2 ** attempt));
    }
  };
}

async function safeJson(res: Response) { try { return await res.json(); } catch { return null; } }
