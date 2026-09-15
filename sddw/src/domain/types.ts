/**
 * Domain model for the Spec Driven Development Workbench.
 * Storage-agnostic; see docs/05-data-model.md.
 */

export type LifecycleStage = 'Draft' | 'Review' | 'Certified' | 'In Delivery' | 'Released' | 'Retired';
export const LIFECYCLE_STAGES: LifecycleStage[] = ['Draft', 'Review', 'Certified', 'In Delivery', 'Released', 'Retired'];

export type SpecStatus = 'Active' | 'On hold' | 'Archived';
export type DataClassification = 'public' | 'internal' | 'confidential' | 'restricted';

export interface UserRef {
  id: string;            // Entra object id or UPN
  displayName: string;
  email: string;
}

export type SectionGroup = 'Product' | 'UX' | 'Architecture' | 'Data' | 'Engineering' | 'QA' | 'Operations';

export type SectionKey =
  | 'productIntent' | 'personas' | 'userJourneys'
  | 'uxRequirements' | 'accessibilityRequirements'
  | 'architecture' | 'adrs' | 'nfrs' | 'integrationDesign'
  | 'dataDesign' | 'security' | 'privacy' | 'responsibleAi' | 'safeguarding'
  | 'engineeringPlan'
  | 'qaStrategy'
  | 'devOpsStrategy' | 'operationalReadiness';

export type Completion = 'empty' | 'partial' | 'complete';

// ---- Section content payloads -------------------------------------------------

export interface Requirement { id: string; text: string; priority: 'Must' | 'Should' | 'Could' | 'Wont'; rationale?: string }
export interface Persona { id: string; name: string; role: string; goals: string[]; frustrations: string[] }
export interface Journey { id: string; name: string; persona: string; steps: string[]; outcome: string }
export interface Adr { id: string; title: string; status: 'Proposed' | 'Accepted' | 'Superseded' | 'Rejected'; context: string; decision: string; consequences: string }
export interface Nfr { id: string; category: string; text: string; target?: string }
export interface Integration { id: string; system: string; direction: 'inbound' | 'outbound' | 'bidirectional'; protocol: string; notes?: string }
export interface Entity { name: string; description: string; fields: string[]; classification: DataClassification }
export interface Control { id: string; text: string; owner?: string; status: 'planned' | 'in-place' | 'n/a' }
export interface Milestone { id: string; name: string; due?: string; deliverables: string[] }
export interface ChecklistItem { id: string; text: string; done: boolean }

export interface SectionContentMap {
  productIntent: { problem: string; outcome: string; successMetrics: string[]; constraints: string[] };
  personas: { personas: Persona[] };
  userJourneys: { journeys: Journey[] };
  uxRequirements: { requirements: Requirement[]; notes: string };
  accessibilityRequirements: { standard: 'WCAG 2.1 AA' | 'WCAG 2.2 AA' | 'WCAG 2.2 AAA'; assistiveTech: string[]; requirements: Requirement[]; notes: string };
  architecture: { overview: string; components: string[]; diagramMermaid: string; patterns: string[] };
  adrs: { adrs: Adr[] };
  nfrs: { nfrs: Nfr[] };
  integrationDesign: { integrations: Integration[]; notes: string };
  dataDesign: { entities: Entity[]; retention: string; notes: string };
  security: { threatModelRef: string; controls: Control[] };
  privacy: { dpiaRef: string; lawfulBasis: string; personalDataCategories: string[]; controls: Control[] };
  responsibleAi: { usesAi: boolean; riskTier: 'none' | 'low' | 'medium' | 'high'; humanOversight: string; controls: Control[] };
  safeguarding: { applies: boolean; considerations: string[]; controls: Control[] };
  engineeringPlan: { approach: string; milestones: Milestone[]; teams: string[]; dependencies: string[] };
  qaStrategy: { approach: string; testLevels: string[]; environments: string[]; exitCriteria: string[] };
  devOpsStrategy: { pipeline: string; environments: string[]; checklist: ChecklistItem[] };
  operationalReadiness: { runbookRef: string; sloTargets: string[]; alerting: string; checklist: ChecklistItem[] };
}

export type SectionContent = SectionContentMap[SectionKey];

export interface Section<K extends SectionKey = SectionKey> {
  key: K;
  group: SectionGroup;
  completion: Completion;
  content: SectionContentMap[K];
  lastEditedBy?: UserRef;
  lastEditedAt?: string;
  source: 'human' | 'ai';
}

export type Sections = { [K in SectionKey]: Section<K> };

// ---- Specification -------------------------------------------------------------

export interface SpecificationSummary {
  id: string;
  title: string;
  productArea: string;
  status: SpecStatus;
  lifecycleStage: LifecycleStage;
  owner: UserRef;
  tags: string[];
  currentVersion: string;
  completion: number;
  updatedAt: string;
  updatedBy: UserRef;
}

export interface Specification extends SpecificationSummary {
  contributors: UserRef[];
  createdAt: string;
  dataClassification: DataClassification;
  certificationStale: boolean;
}

export interface SpecificationVersion {
  specId: string;
  version: string;
  sections: Sections;
  markdown: string;
  manifestYaml: string;
  etag: string;
  certifiedAt?: string;
  createdAt: string;
  createdBy: UserRef;
}

export interface NewSpecification {
  title: string;
  productArea: string;
  owner: UserRef;
  tags?: string[];
  dataClassification?: DataClassification;
}

// ---- Review -----------------------------------------------------------------

export type ReviewKind = 'ai-review' | 'critique' | 'contradictions' | 'constitution' | 'reuse' | 'architecture' | 'privacy' | 'generate' | 'adrs' | 'delivery-pack' | 'human';
export type RunState = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
export type FindingCategory = 'warning' | 'risk' | 'open-question' | 'suggested-change';
export type Severity = 'blocker' | 'high' | 'medium' | 'low';
export type FindingStatus = 'open' | 'accepted' | 'rejected' | 'resolved';

export interface Finding {
  id: string;
  reviewId: string;
  category: FindingCategory;
  severity: Severity;
  sectionKey: SectionKey;
  title: string;
  rationale: string;
  suggestion?: string;
  status: FindingStatus;
  resolvedBy?: UserRef;
  resolution?: string;
}

export interface Review {
  id: string;
  specId: string;
  version: string;
  kind: ReviewKind;
  status: RunState;
  requestedBy: UserRef;
  requestedAt: string;
  completedAt?: string;
  agentVersion?: string;
  correlationId: string;
  findings: Finding[];
  reviewers?: { user: UserRef; verdict: 'pending' | 'approve' | 'request-changes'; comment?: string }[];
}

// ---- Certification -----------------------------------------------------------

export type ApprovalType = 'architecture' | 'privacy' | 'security' | 'product';
export const APPROVAL_TYPES: ApprovalType[] = ['architecture', 'privacy', 'security', 'product'];
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'waived';

export interface Evidence {
  id: string;
  kind: 'link' | 'file' | 'review-run';
  label: string;
  uri?: string;
  driveItemId?: string;
  reviewId?: string;
  addedBy: UserRef;
  addedAt: string;
}

export interface Approval {
  id: string;
  specId: string;
  version: string;
  type: ApprovalType;
  status: ApprovalStatus;
  approver?: UserRef;
  decidedAt?: string;
  comment?: string;
  waiverReason?: string;
  secondApprover?: UserRef;
  evidence: Evidence[];
}

// ---- Delivery ---------------------------------------------------------------

export type DeliveryItemType = 'epic' | 'story' | 'acceptance-criterion' | 'adr' | 'task' | 'qa-case' | 'bdd-scenario' | 'devops-check';

export interface DeliveryItem {
  id: string;
  type: DeliveryItemType;
  key: string;
  title: string;
  body: string;
  parentId?: string;
  tracesTo: string[]; // section keys and/or requirement ids
}

export interface DeliveryPack {
  id: string;
  specId: string;
  version: string;
  generatedAt: string;
  generatedBy: UserRef;
  reviewId?: string;
  exportedTo?: string;
  items: DeliveryItem[];
}

// ---- Audit ------------------------------------------------------------------

export type AuditAction =
  | 'created' | 'section.updated' | 'stage.promoted' | 'stage.demoted'
  | 'ai.run' | 'ai.accepted' | 'ai.rejected'
  | 'approval.set' | 'evidence.added' | 'pack.generated' | 'pack.exported';

export interface AuditEvent {
  id: string;
  specId: string;
  version: string;
  action: AuditAction;
  actor: UserRef;
  at: string;
  summary: string;
  before?: unknown;
  after?: unknown;
}

// ---- Dashboard --------------------------------------------------------------

export interface DashboardSnapshot {
  byStage: Record<LifecycleStage, number>;
  openBlockers: { spec: SpecificationSummary; finding: Finding }[];
  pendingReviews: { spec: SpecificationSummary; review: Review }[];
  certificationQueue: { spec: SpecificationSummary; approvals: Approval[] }[];
  recentlyModified: SpecificationSummary[];
}

export interface CatalogueQuery {
  search?: string;
  productArea?: string[];
  owner?: string[];
  status?: SpecStatus[];
  tag?: string[];
  lifecycleStage?: LifecycleStage[];
  sort?: { field: keyof SpecificationSummary; dir: 'asc' | 'desc' };
  page?: number;
  pageSize?: number;
}

export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }
