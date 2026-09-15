# 9. API Layer Design — SDD Companion as a service

The SDD Companion (Copilot Studio) is wrapped by a thin **Companion Gateway** (Azure Function or Power Automate HTTP flow owned by the agent team) that exposes stable, versioned REST operations. The web app only ever talks to the gateway. Prompt engineering, agent topics and model selection live behind the gateway.

## 9.1 Operations

Base: `{COMPANION_BASE_URL}/v1`

| Operation | Method & path | Body | Result |
|---|---|---|---|
| Full review | `POST /specifications/{id}/review` | `{ version, correlationId, guidance? }` | `RunAccepted` |
| Generate section | `POST /specifications/{id}/sections/{key}/generate` | `{ version, guidance? }` | `RunAccepted` |
| Critique section | `POST /specifications/{id}/sections/{key}/critique` | `{ version }` | `RunAccepted` |
| Detect contradictions | `POST /specifications/{id}/contradictions` | `{ version }` | `RunAccepted` |
| Constitution review | `POST /specifications/{id}/constitution-review` | `{ version }` | `RunAccepted` |
| Reuse review | `POST /specifications/{id}/reuse-review` | `{ version }` | `RunAccepted` |
| Architecture review | `POST /specifications/{id}/architecture-review` | `{ version }` | `RunAccepted` |
| Privacy review | `POST /specifications/{id}/privacy-review` | `{ version }` | `RunAccepted` |
| Generate ADRs | `POST /specifications/{id}/generate-adrs` | `{ version }` | `RunAccepted` |
| Generate delivery pack | `POST /specifications/{id}/generate-delivery-pack` | `{ version }` | `RunAccepted` |
| Poll run | `GET /runs/{runId}` | | `RunStatus` |
| Cancel run | `DELETE /runs/{runId}` | | 204 |

All operations are **asynchronous**: they return `202 Accepted` with a run ID; the client polls. The gateway fetches the specification model itself (from the same storage the app uses, via the caller's delegated token or an application identity) so the app never uploads the document.

## 9.2 Schemas (TypeScript in `src/services/companion/types.ts`)

```ts
interface RunAccepted { runId: string; status: 'queued'; estimatedSeconds?: number }

interface RunStatus<T = CompanionResult> {
  runId: string;
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  progress?: number;                 // 0..1
  result?: T;
  error?: { code: string; message: string };
  agentVersion: string;
  correlationId: string;
}

type CompanionResult =
  | { kind: 'findings'; findings: Finding[] }                      // review, contradictions, constitution, architecture, privacy
  | { kind: 'section-proposal'; sectionKey: SectionKey; proposal: SectionContent; rationale: string; confidence: 'low'|'medium'|'high' }
  | { kind: 'reuse'; candidates: ReuseCandidate[]; findings: Finding[] }
  | { kind: 'adrs'; adrs: Adr[] }
  | { kind: 'delivery-pack'; items: DeliveryItem[] };
```

`Finding`, `Adr`, `DeliveryItem`, `SectionContent` are the domain types in `src/domain/types.ts`; the gateway contract is the domain model. Structured results only — never free text as the primary payload.

## 9.3 Contract rules

1. **Idempotency**: `Idempotency-Key` header = hash(operation, specId, version, guidance). Re-posting returns the existing run.
2. **Correlation**: `x-correlation-id` on every call, echoed back and stored on the Review record.
3. **Auth**: Bearer token from MSAL for the gateway's own Entra app registration (scope `api://sdd-companion-gateway/Specifications.ReadWrite`). The gateway validates the token and enforces that the caller can read the specification.
4. **Versioning**: path version `/v1`; breaking changes create `/v2`. Result `kind` discriminators are additive.
5. **Errors**: RFC 9457 problem+json.
6. **Rate limits**: 429 with `Retry-After`; client backs off exponentially, max 5 attempts.

## 9.4 Client layering in the app

```
feature hook (useRunCompanionAction)
  └─ CompanionClient.review(specId, version)   → RunAccepted
  └─ CompanionClient.pollRun(runId)            → RunStatus
       └─ httpClient (fetch + auth + correlation + retry)
review service persists Review + Findings via SpecificationRepository
```

`MockCompanionClient` returns deterministic fixtures with simulated latency so the UI is fully demonstrable without the agent.

## 9.5 Storage API surface (repository interface)

```ts
interface SpecificationRepository {
  list(query: CatalogueQuery): Promise<Page<SpecificationSummary>>;
  get(id: string): Promise<Specification>;
  getVersion(id: string, version: string): Promise<SpecificationVersion>;
  create(input: NewSpecification, actor: UserRef): Promise<Specification>;
  saveSection(id, version, section, etag, actor): Promise<SpecificationVersion>;
  promote(id, to: LifecycleStage, actor, reason?): Promise<Specification>;
  listReviews(id): Promise<Review[]>;  saveReview(review): Promise<Review>;  updateFinding(...)
  listApprovals(id, version): Promise<Approval[]>;  setApproval(...);  addEvidence(...)
  savePack(pack): Promise<DeliveryPack>;  getPack(id, version)
  appendAudit(event): Promise<void>;  listAudit(id): Promise<AuditEvent[]>
  dashboard(filter): Promise<DashboardSnapshot>;
}
```
