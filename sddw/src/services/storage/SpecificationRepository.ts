import type {
  Approval, ApprovalType, AuditEvent, CatalogueQuery, DashboardSnapshot, DeliveryPack, Evidence, Finding, LifecycleStage,
  NewSpecification, Page, Review, SectionContentMap, SectionKey, Specification, SpecificationSummary, SpecificationVersion, UserRef,
} from '@/domain/types';

/**
 * The single storage contract used by the UI. Implemented by the SharePoint, Dataverse and in-memory adapters.
 * See ADR-0002 and docs/09-api-layer-design.md §9.5.
 */
export interface SpecificationRepository {
  // catalogue & dashboard
  list(query: CatalogueQuery): Promise<Page<SpecificationSummary>>;
  dashboard(filter?: { productArea?: string }): Promise<DashboardSnapshot>;
  productAreas(): Promise<string[]>;
  tags(): Promise<string[]>;

  // specification & versions
  get(id: string): Promise<Specification>;
  getVersion(id: string, version?: string): Promise<SpecificationVersion>;
  listVersions(id: string): Promise<Pick<SpecificationVersion, 'version' | 'createdAt' | 'createdBy' | 'certifiedAt'>[]>;
  create(input: NewSpecification, actor: UserRef): Promise<Specification>;
  saveSection<K extends SectionKey>(args: { id: string; version: string; key: K; content: SectionContentMap[K]; etag: string; actor: UserRef; source?: 'human' | 'ai' }): Promise<SpecificationVersion>;
  updateHeader(id: string, patch: Partial<Pick<Specification, 'title' | 'productArea' | 'status' | 'tags' | 'contributors' | 'owner'>>, actor: UserRef): Promise<Specification>;
  promote(id: string, to: LifecycleStage, actor: UserRef, reason?: string): Promise<Specification>;

  // reviews
  listReviews(id: string): Promise<Review[]>;
  saveReview(review: Review): Promise<Review>;
  updateFinding(id: string, reviewId: string, findingId: string, patch: Partial<Finding>, actor: UserRef): Promise<Finding>;

  // certification
  listApprovals(id: string, version: string): Promise<Approval[]>;
  setApproval(args: { id: string; version: string; type: ApprovalType; status: Approval['status']; actor: UserRef; comment?: string; waiverReason?: string; secondApprover?: UserRef }): Promise<Approval>;
  addEvidence(id: string, approvalId: string, evidence: Omit<Evidence, 'id' | 'addedAt' | 'addedBy'>, actor: UserRef): Promise<Approval>;

  // delivery
  getPack(id: string, version: string): Promise<DeliveryPack | null>;
  savePack(pack: DeliveryPack): Promise<DeliveryPack>;

  // audit
  appendAudit(event: Omit<AuditEvent, 'id' | 'at'>): Promise<void>;
  listAudit(id: string): Promise<AuditEvent[]>;
}

export class ConcurrencyError extends Error {
  constructor(public readonly currentEtag: string) { super('The specification was modified by someone else. Reload and merge your changes.'); this.name = 'ConcurrencyError'; }
}
export class GuardError extends Error {
  constructor(message: string, public readonly checks: { label: string; ok: boolean; detail?: string }[]) { super(message); this.name = 'GuardError'; }
}
