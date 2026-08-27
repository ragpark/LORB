import { newCorrelationId } from './correlation.js';
import { session } from './auth.js';
import { redactHeaders, containsForbiddenField } from './redaction.js';

export interface ApiProblem {
  code: string;
  title: string;
  detail: string;
  correlation_id: string;
  retryable: boolean;
  field_errors: unknown[];
}
export class AdminApiError extends Error {
  constructor(readonly problem: ApiProblem) {
    super(problem.code);
  }
}

export interface Diagnostic {
  at: string;
  direction: 'outbound' | 'inbound';
  method: string;
  url: string;
  correlationId: string;
  status?: number;
  durationMs?: number;
  errorCode?: string;
  auditId?: string;
  headers?: Record<string, string>;
}
let diagnosticLog: Diagnostic[] = [];
const diagnosticListeners = new Set<() => void>();
export const diagnostics = {
  snapshot: () => diagnosticLog,
  subscribe: (fn: () => void) => {
    diagnosticListeners.add(fn);
    return () => diagnosticListeners.delete(fn);
  },
};
function pushDiagnostic(entry: Omit<Diagnostic, 'at'>) {
  diagnosticLog = [...diagnosticLog, { ...entry, at: new Date().toISOString() }].slice(-100);
  diagnosticListeners.forEach((fn) => fn());
}

export type AdminRequestOptions = { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown };

export async function adminApiRequest<T>(base: string, path: string, options: AdminRequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const correlationId = newCorrelationId();
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Correlation-ID': correlationId };
  const token = session.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['Idempotency-Key'] = newCorrelationId();

  const url = `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  const started = performance.now();
  pushDiagnostic({ direction: 'outbound', method, url, correlationId, headers: redactHeaders(headers) });

  const response = await fetch(url, { method, headers, body: options.body !== undefined ? JSON.stringify(options.body) : undefined });
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('json') ? await response.json() : {};
  const durationMs = performance.now() - started;
  pushDiagnostic({ direction: 'inbound', method, url, correlationId, status: response.status, durationMs, errorCode: response.ok ? undefined : (body as ApiProblem).code });

  if (containsForbiddenField(body)) throw new Error('SUSPECTED_LEAK');
  if (!response.ok) throw new AdminApiError(body as ApiProblem);
  return body as T;
}

export function adminApiUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
