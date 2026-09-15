import { createHttp, type TokenProvider } from '@/services/http';
import { RunStatusSchema, type CompanionClient, type RunAccepted, type RunRequest, type RunStatus } from './types';

const PATHS: Record<RunRequest['action'], (r: RunRequest) => string> = {
  review: (r) => `/specifications/${r.specId}/review`,
  'generate-section': (r) => `/specifications/${r.specId}/sections/${r.sectionKey}/generate`,
  'critique-section': (r) => `/specifications/${r.specId}/sections/${r.sectionKey}/critique`,
  contradictions: (r) => `/specifications/${r.specId}/contradictions`,
  'constitution-review': (r) => `/specifications/${r.specId}/constitution-review`,
  'reuse-review': (r) => `/specifications/${r.specId}/reuse-review`,
  'architecture-review': (r) => `/specifications/${r.specId}/architecture-review`,
  'privacy-review': (r) => `/specifications/${r.specId}/privacy-review`,
  'generate-adrs': (r) => `/specifications/${r.specId}/generate-adrs`,
  'generate-delivery-pack': (r) => `/specifications/${r.specId}/generate-delivery-pack`,
};

/** Real gateway client. The UI never sends prompt text — only the structured request. */
export class HttpCompanionClient implements CompanionClient {
  private readonly http: ReturnType<typeof createHttp>;
  constructor(getToken: TokenProvider, private readonly baseUrl: string, private readonly scope: string) { this.http = createHttp(getToken); }
  private url(p: string) { return `${this.baseUrl.replace(/\/$/, '')}/v1${p}`; }

  async start(req: RunRequest): Promise<RunAccepted> {
    const idem = await sha256(`${req.action}|${req.specId}|${req.version}|${req.sectionKey ?? ''}|${req.guidance ?? ''}`);
    return this.http<RunAccepted>(this.url(PATHS[req.action](req)), {
      method: 'POST', scope: this.scope, body: { version: req.version, guidance: req.guidance, correlationId: req.correlationId },
      headers: { 'Idempotency-Key': idem, 'x-correlation-id': req.correlationId },
    });
  }
  async poll(runId: string): Promise<RunStatus> {
    const raw = await this.http<unknown>(this.url(`/runs/${runId}`), { scope: this.scope });
    return RunStatusSchema.parse(raw) as RunStatus;
  }
  async cancel(runId: string): Promise<void> { await this.http<void>(this.url(`/runs/${runId}`), { method: 'DELETE', scope: this.scope }); }
}

async function sha256(s: string): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return btoa(s).slice(0, 64);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
