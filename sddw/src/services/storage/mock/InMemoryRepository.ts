import { evaluateTransition, bumpVersion } from '@/domain/lifecycle';
import { renderManifestYaml, renderMarkdown } from '@/domain/manifest';
import { emptySections, overallCompletion, withSection } from '@/domain/sections';
import { nowIso, specIdFor, uid } from '@/domain/ids';
import type {
  Approval, AuditEvent, CatalogueQuery, DashboardSnapshot, DeliveryPack, Finding, LifecycleStage, NewSpecification, Page, Review,
  SectionContentMap, SectionKey, Specification, SpecificationSummary, SpecificationVersion, UserRef,
} from '@/domain/types';
import { APPROVAL_TYPES, LIFECYCLE_STAGES } from '@/domain/types';
import { ConcurrencyError, GuardError, type SpecificationRepository } from '../SpecificationRepository';

export interface MemoryState {
  specs: Map<string, Specification>;
  versions: Map<string, SpecificationVersion[]>; // by specId
  reviews: Map<string, Review[]>;
  approvals: Map<string, Approval[]>;              // by `${specId}@${version}`
  packs: Map<string, DeliveryPack>;                // by `${specId}@${version}`
  audit: Map<string, AuditEvent[]>;
  seq: Map<string, number>;
}

const delay = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const summary = (s: Specification): SpecificationSummary => ({
  id: s.id, title: s.title, productArea: s.productArea, status: s.status, lifecycleStage: s.lifecycleStage, owner: s.owner,
  tags: s.tags, currentVersion: s.currentVersion, completion: s.completion, updatedAt: s.updatedAt, updatedBy: s.updatedBy,
});

/**
 * In-memory implementation used for local development, demos and tests.
 * Behaviour (guards, versioning, audit) is identical to the real adapters so the UI is fully exercisable offline.
 */
export class InMemoryRepository implements SpecificationRepository {
  constructor(public readonly state: MemoryState = { specs: new Map(), versions: new Map(), reviews: new Map(), approvals: new Map(), packs: new Map(), audit: new Map(), seq: new Map() }) {}

  private current(id: string): SpecificationVersion {
    const spec = this.state.specs.get(id);
    if (!spec) throw new Error(`Specification ${id} not found`);
    const v = this.state.versions.get(id)?.find((x) => x.version === spec.currentVersion);
    if (!v) throw new Error(`Version ${spec.currentVersion} of ${id} not found`);
    return v;
  }

  async list(q: CatalogueQuery): Promise<Page<SpecificationSummary>> {
    await delay();
    let items = [...this.state.specs.values()].map(summary);
    if (q.search) { const s = q.search.toLowerCase(); items = items.filter((i) => i.title.toLowerCase().includes(s) || i.id.toLowerCase().includes(s)); }
    if (q.productArea?.length) items = items.filter((i) => q.productArea!.includes(i.productArea));
    if (q.owner?.length) items = items.filter((i) => q.owner!.includes(i.owner.id));
    if (q.status?.length) items = items.filter((i) => q.status!.includes(i.status));
    if (q.lifecycleStage?.length) items = items.filter((i) => q.lifecycleStage!.includes(i.lifecycleStage));
    if (q.tag?.length) items = items.filter((i) => i.tags.some((t) => q.tag!.includes(t)));
    const sort = q.sort ?? { field: 'updatedAt', dir: 'desc' };
    items.sort((a, b) => { const av = String(sortVal(a, sort.field)), bv = String(sortVal(b, sort.field)); return sort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av); });
    const page = q.page ?? 1, pageSize = q.pageSize ?? 25;
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize };
  }

  async dashboard(filter?: { productArea?: string }): Promise<DashboardSnapshot> {
    await delay();
    const specs = [...this.state.specs.values()].filter((s) => !filter?.productArea || s.productArea === filter.productArea);
    const byStage = Object.fromEntries(LIFECYCLE_STAGES.map((s) => [s, 0])) as Record<LifecycleStage, number>;
    for (const s of specs) byStage[s.lifecycleStage]++;
    const openBlockers: DashboardSnapshot['openBlockers'] = [];
    const pendingReviews: DashboardSnapshot['pendingReviews'] = [];
    const certificationQueue: DashboardSnapshot['certificationQueue'] = [];
    for (const s of specs) {
      const reviews = this.state.reviews.get(s.id) ?? [];
      for (const r of reviews) for (const f of r.findings) if (f.status === 'open' && f.severity === 'blocker') openBlockers.push({ spec: summary(s), finding: f });
      const latest = reviews.filter((r) => r.findings.some((f) => f.status === 'open') || r.reviewers?.some((x) => x.verdict === 'pending')).at(-1);
      if (s.lifecycleStage === 'Review' && latest) pendingReviews.push({ spec: summary(s), review: latest });
      const approvals = this.state.approvals.get(`${s.id}@${s.currentVersion}`) ?? [];
      if ((s.lifecycleStage === 'Review' || s.lifecycleStage === 'Certified') && approvals.some((a) => a.status === 'pending')) certificationQueue.push({ spec: summary(s), approvals });
    }
    const recentlyModified = specs.map(summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10);
    return { byStage, openBlockers, pendingReviews, certificationQueue, recentlyModified };
  }

  async productAreas() { return [...new Set([...this.state.specs.values()].map((s) => s.productArea))].sort(); }
  async tags() { return [...new Set([...this.state.specs.values()].flatMap((s) => s.tags))].sort(); }

  async get(id: string) { await delay(); const s = this.state.specs.get(id); if (!s) throw new Error(`Specification ${id} not found`); return structuredClone(s); }
  async getVersion(id: string, version?: string) { await delay(); const v = version ? this.state.versions.get(id)?.find((x) => x.version === version) : this.current(id); if (!v) throw new Error('Version not found'); return structuredClone(v); }
  async listVersions(id: string) { return (this.state.versions.get(id) ?? []).map(({ version, createdAt, createdBy, certifiedAt }) => ({ version, createdAt, createdBy, certifiedAt })); }

  async create(input: NewSpecification, actor: UserRef): Promise<Specification> {
    await delay();
    const seq = (this.state.seq.get(input.productArea) ?? 0) + 1;
    this.state.seq.set(input.productArea, seq);
    const id = specIdFor(input.productArea, seq);
    const at = nowIso();
    const spec: Specification = {
      id, title: input.title, productArea: input.productArea, status: 'Active', lifecycleStage: 'Draft', owner: input.owner, contributors: [],
      tags: input.tags ?? [], currentVersion: '0.1', completion: 0, createdAt: at, updatedAt: at, updatedBy: actor,
      dataClassification: input.dataClassification ?? 'internal', certificationStale: false,
    };
    const sections = emptySections();
    const v: SpecificationVersion = { specId: id, version: '0.1', sections, markdown: '', manifestYaml: '', etag: uid('etag'), createdAt: at, createdBy: actor };
    v.markdown = renderMarkdown({ spec, version: v.version, sections });
    v.manifestYaml = renderManifestYaml({ spec, version: v.version, sections });
    this.state.specs.set(id, spec);
    this.state.versions.set(id, [v]);
    this.state.approvals.set(`${id}@0.1`, APPROVAL_TYPES.map((type) => ({ id: uid('apr'), specId: id, version: '0.1', type, status: 'pending', evidence: [] })));
    await this.appendAudit({ specId: id, version: '0.1', action: 'created', actor, summary: `Created ${id} “${spec.title}”` });
    return structuredClone(spec);
  }

  async saveSection<K extends SectionKey>(args: { id: string; version: string; key: K; content: SectionContentMap[K]; etag: string; actor: UserRef; source?: 'human' | 'ai' }): Promise<SpecificationVersion> {
    await delay();
    const spec = this.state.specs.get(args.id)!;
    let v = this.current(args.id);
    if (v.etag !== args.etag) throw new ConcurrencyError(v.etag);
    // Editing a certified/in-delivery spec opens a new draft version and marks certification stale.
    if (spec.lifecycleStage === 'Certified' || spec.lifecycleStage === 'In Delivery') {
      const nv: SpecificationVersion = { ...structuredClone(v), version: bumpVersion(v.version, 'save'), etag: uid('etag'), createdAt: nowIso(), createdBy: args.actor, certifiedAt: undefined };
      this.state.versions.get(args.id)!.push(nv);
      this.state.approvals.set(`${args.id}@${nv.version}`, APPROVAL_TYPES.map((type) => ({ id: uid('apr'), specId: args.id, version: nv.version, type, status: 'pending', evidence: [] })));
      spec.currentVersion = nv.version; spec.lifecycleStage = 'Draft'; spec.certificationStale = true;
      v = nv;
    }
    const before = v.sections[args.key].completion;
    v.sections = withSection(v.sections, args.key, args.content, { lastEditedBy: args.actor, lastEditedAt: nowIso(), source: args.source ?? 'human' });
    v.etag = uid('etag');
    spec.completion = overallCompletion(v.sections);
    spec.updatedAt = nowIso(); spec.updatedBy = args.actor;
    v.markdown = renderMarkdown({ spec, version: v.version, sections: v.sections });
    v.manifestYaml = renderManifestYaml({ spec, version: v.version, sections: v.sections, approvals: this.state.approvals.get(`${spec.id}@${v.version}`), findings: (this.state.reviews.get(spec.id) ?? []).flatMap((r) => r.findings) });
    await this.appendAudit({ specId: spec.id, version: v.version, action: 'section.updated', actor: args.actor, summary: `Updated ${args.key} (${before} → ${v.sections[args.key].completion})${args.source === 'ai' ? ' from AI proposal' : ''}` });
    return structuredClone(v);
  }

  async updateHeader(id: string, patch: Partial<Pick<Specification, 'title' | 'productArea' | 'status' | 'tags' | 'contributors' | 'owner'>>, actor: UserRef) {
    const spec = this.state.specs.get(id)!;
    Object.assign(spec, patch, { updatedAt: nowIso(), updatedBy: actor });
    return structuredClone(spec);
  }

  async promote(id: string, to: LifecycleStage, actor: UserRef, reason?: string): Promise<Specification> {
    await delay();
    const spec = this.state.specs.get(id)!;
    const v = this.current(id);
    const approvals = this.state.approvals.get(`${id}@${v.version}`) ?? [];
    const openBlockers = (this.state.reviews.get(id) ?? []).flatMap((r) => r.findings).filter((f) => f.status === 'open' && f.severity === 'blocker');
    const evaluation = evaluateTransition(to, {
      spec, productIntentComplete: v.sections.productIntent.completion === 'complete', openBlockers, approvals,
      hasDeliveryPack: this.state.packs.has(`${id}@${v.version}`),
      hasReleaseEvidence: approvals.some((a) => a.evidence.length > 0) || spec.lifecycleStage === 'In Delivery',
      reason,
    });
    if (!evaluation.allowed) throw new GuardError(`Cannot move ${spec.lifecycleStage} → ${to}`, evaluation.checks);
    const from = spec.lifecycleStage;
    spec.lifecycleStage = to; spec.updatedAt = nowIso(); spec.updatedBy = actor;
    if (to === 'Certified') { v.certifiedAt = nowIso(); spec.certificationStale = false; const nv = bumpVersion(v.version, 'certify'); v.version = nv; spec.currentVersion = nv; this.state.approvals.set(`${id}@${nv}`, approvals.map((a) => ({ ...a, version: nv }))); }
    v.manifestYaml = renderManifestYaml({ spec, version: v.version, sections: v.sections, approvals });
    await this.appendAudit({ specId: id, version: v.version, action: evaluation.kind === 'promote' ? 'stage.promoted' : 'stage.demoted', actor, summary: `${from} → ${to}${reason ? `: ${reason}` : ''}`, before: from, after: to });
    return structuredClone(spec);
  }

  async listReviews(id: string) { await delay(); return structuredClone(this.state.reviews.get(id) ?? []); }
  async saveReview(review: Review) {
    const arr = this.state.reviews.get(review.specId) ?? [];
    const i = arr.findIndex((r) => r.id === review.id);
    if (i >= 0) arr[i] = review; else arr.push(review);
    this.state.reviews.set(review.specId, arr);
    return structuredClone(review);
  }
  async updateFinding(id: string, reviewId: string, findingId: string, patch: Partial<Finding>, actor: UserRef) {
    const r = (this.state.reviews.get(id) ?? []).find((x) => x.id === reviewId);
    const f = r?.findings.find((x) => x.id === findingId);
    if (!f) throw new Error('Finding not found');
    Object.assign(f, patch, patch.status && patch.status !== 'open' ? { resolvedBy: actor } : {});
    return structuredClone(f);
  }

  async listApprovals(id: string, version: string) { await delay(); return structuredClone(this.state.approvals.get(`${id}@${version}`) ?? []); }
  async setApproval(args: { id: string; version: string; type: Approval['type']; status: Approval['status']; actor: UserRef; comment?: string; waiverReason?: string; secondApprover?: UserRef }) {
    const arr = this.state.approvals.get(`${args.id}@${args.version}`) ?? [];
    const a = arr.find((x) => x.type === args.type);
    if (!a) throw new Error('Approval not found');
    Object.assign(a, { status: args.status, approver: args.actor, decidedAt: nowIso(), comment: args.comment, waiverReason: args.waiverReason, secondApprover: args.secondApprover });
    await this.appendAudit({ specId: args.id, version: args.version, action: 'approval.set', actor: args.actor, summary: `${args.type} approval set to ${args.status}` });
    return structuredClone(a);
  }
  async addEvidence(id: string, approvalId: string, evidence: Omit<Approval['evidence'][number], 'id' | 'addedAt' | 'addedBy'>, actor: UserRef) {
    for (const arr of this.state.approvals.values()) {
      const a = arr.find((x) => x.id === approvalId && x.specId === id);
      if (a) { a.evidence.push({ ...evidence, id: uid('ev'), addedAt: nowIso(), addedBy: actor }); await this.appendAudit({ specId: id, version: a.version, action: 'evidence.added', actor, summary: `Evidence “${evidence.label}” added to ${a.type}` }); return structuredClone(a); }
    }
    throw new Error('Approval not found');
  }

  async getPack(id: string, version: string) { await delay(); return structuredClone(this.state.packs.get(`${id}@${version}`) ?? null); }
  async savePack(pack: DeliveryPack) { this.state.packs.set(`${pack.specId}@${pack.version}`, pack); await this.appendAudit({ specId: pack.specId, version: pack.version, action: 'pack.generated', actor: pack.generatedBy, summary: `Delivery pack generated (${pack.items.length} items)` }); return structuredClone(pack); }

  async appendAudit(event: Omit<AuditEvent, 'id' | 'at'>) {
    const arr = this.state.audit.get(event.specId) ?? [];
    arr.push({ ...event, id: uid('aud'), at: nowIso() });
    this.state.audit.set(event.specId, arr);
  }
  async listAudit(id: string) { return structuredClone([...(this.state.audit.get(id) ?? [])].reverse()); }
}

function sortVal(s: SpecificationSummary, field: keyof SpecificationSummary): unknown {
  const v = s[field];
  return typeof v === 'object' && v && 'displayName' in v ? v.displayName : v;
}
