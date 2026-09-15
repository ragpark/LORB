import { evaluateTransition, bumpVersion } from '@/domain/lifecycle';
import { renderManifestYaml, renderMarkdown } from '@/domain/manifest';
import { emptySections, overallCompletion, withSection } from '@/domain/sections';
import { nowIso, specIdFor, uid } from '@/domain/ids';
import { APPROVAL_TYPES, LIFECYCLE_STAGES } from '@/domain/types';
import type {
  Approval, AuditEvent, CatalogueQuery, DashboardSnapshot, DeliveryPack, Finding, LifecycleStage, NewSpecification, Page, Review,
  SectionContentMap, SectionKey, Specification, SpecificationSummary, SpecificationVersion, UserRef,
} from '@/domain/types';
import type { GraphClient } from '@/services/graph/graphClient';
import { ConcurrencyError, GuardError, type SpecificationRepository } from '../SpecificationRepository';

/**
 * SharePoint-first adapter (Option A — docs/06-sharepoint-design.md).
 *
 * Lists:   Specifications, Reviews, Approvals, Deliverables, AuditEvents
 * Library: SpecDocuments/<SpecId>/v<version>/{spec.md, manifest.yaml, model.json}
 *
 * The structured model for the *current* version is mirrored in the Specifications list column
 * `ManifestJson` so catalogue and dashboard queries need no drive round-trips.
 */
export interface SharePointConfig { siteId: string; driveId: string; lists?: Partial<typeof DEFAULT_LISTS> }

const DEFAULT_LISTS = { specifications: 'Specifications', reviews: 'Reviews', approvals: 'Approvals', deliverables: 'Deliverables', audit: 'AuditEvents' };

interface ListItem<F> { id: string; eTag?: string; fields: F }
interface SpecFields {
  Title: string; SpecId: string; ProductArea: string; Status: string; LifecycleStage: string; OwnerJson: string; ContributorsJson: string;
  Tags: string; CurrentVersion: string; Completion: number; DataClassification: string; CertificationStale: boolean; CreatedAtIso: string; UpdatedAtIso: string; UpdatedByJson: string; ModelJson: string;
}

export class SharePointRepository implements SpecificationRepository {
  private readonly lists: typeof DEFAULT_LISTS;
  constructor(private readonly graph: GraphClient, private readonly cfg: SharePointConfig) { this.lists = { ...DEFAULT_LISTS, ...cfg.lists }; }

  private listPath(name: keyof typeof DEFAULT_LISTS) { return `/sites/${this.cfg.siteId}/lists/${encodeURIComponent(this.lists[name])}/items`; }
  private docPath(specId: string, version: string, file: string) { return `/drives/${this.cfg.driveId}/root:/${specId}/v${version}/${file}:/content`; }

  private toSpec(item: ListItem<SpecFields>): Specification {
    const f = item.fields;
    return {
      id: f.SpecId, title: f.Title, productArea: f.ProductArea, status: f.Status as Specification['status'], lifecycleStage: f.LifecycleStage as LifecycleStage,
      owner: JSON.parse(f.OwnerJson), contributors: JSON.parse(f.ContributorsJson || '[]'), tags: (f.Tags ?? '').split(';').filter(Boolean),
      currentVersion: f.CurrentVersion, completion: f.Completion ?? 0, createdAt: f.CreatedAtIso, updatedAt: f.UpdatedAtIso, updatedBy: JSON.parse(f.UpdatedByJson),
      dataClassification: (f.DataClassification as Specification['dataClassification']) ?? 'internal', certificationStale: !!f.CertificationStale,
    };
  }
  private toFields(s: Specification, model?: SpecificationVersion): Partial<SpecFields> {
    return {
      Title: s.title, SpecId: s.id, ProductArea: s.productArea, Status: s.status, LifecycleStage: s.lifecycleStage, OwnerJson: JSON.stringify(s.owner),
      ContributorsJson: JSON.stringify(s.contributors), Tags: s.tags.join(';'), CurrentVersion: s.currentVersion, Completion: s.completion,
      DataClassification: s.dataClassification, CertificationStale: s.certificationStale, CreatedAtIso: s.createdAt, UpdatedAtIso: s.updatedAt, UpdatedByJson: JSON.stringify(s.updatedBy),
      ...(model ? { ModelJson: JSON.stringify(model) } : {}),
    };
  }

  private async findSpecItem(id: string): Promise<ListItem<SpecFields>> {
    const r = await this.graph.get<{ value: ListItem<SpecFields>[] }>(`${this.listPath('specifications')}?$expand=fields&$filter=fields/SpecId eq '${id}'`);
    if (!r.value.length) throw new Error(`Specification ${id} not found`);
    return r.value[0];
  }

  async list(q: CatalogueQuery): Promise<Page<SpecificationSummary>> {
    // Only indexed columns are filterable server-side; the rest are applied client-side on the page.
    const filters: string[] = [];
    if (q.lifecycleStage?.length) filters.push(`(${q.lifecycleStage.map((s) => `fields/LifecycleStage eq '${s}'`).join(' or ')})`);
    if (q.productArea?.length) filters.push(`(${q.productArea.map((s) => `fields/ProductArea eq '${s}'`).join(' or ')})`);
    if (q.status?.length) filters.push(`(${q.status.map((s) => `fields/Status eq '${s}'`).join(' or ')})`);
    const filter = filters.length ? `&$filter=${encodeURIComponent(filters.join(' and '))}` : '';
    const r = await this.graph.get<{ value: ListItem<SpecFields>[] }>(`${this.listPath('specifications')}?$expand=fields($select=Title,SpecId,ProductArea,Status,LifecycleStage,OwnerJson,ContributorsJson,Tags,CurrentVersion,Completion,DataClassification,CertificationStale,CreatedAtIso,UpdatedAtIso,UpdatedByJson)&$top=999${filter}`, { headers: { Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' } });
    let items = r.value.map((i) => this.toSpec(i));
    if (q.search) { const s = q.search.toLowerCase(); items = items.filter((i) => i.title.toLowerCase().includes(s) || i.id.toLowerCase().includes(s)); }
    if (q.owner?.length) items = items.filter((i) => q.owner!.includes(i.owner.id));
    if (q.tag?.length) items = items.filter((i) => i.tags.some((t) => q.tag!.includes(t)));
    const sort = q.sort ?? { field: 'updatedAt', dir: 'desc' };
    items.sort((a, b) => { const av = String((a as never)[sort.field] ?? ''), bv = String((b as never)[sort.field] ?? ''); return sort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av); });
    const page = q.page ?? 1, pageSize = q.pageSize ?? 25;
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize };
  }

  async dashboard(filter?: { productArea?: string }): Promise<DashboardSnapshot> {
    const all = (await this.list({ pageSize: 999, productArea: filter?.productArea ? [filter.productArea] : undefined })).items;
    const byStage = Object.fromEntries(LIFECYCLE_STAGES.map((s) => [s, 0])) as Record<LifecycleStage, number>;
    for (const s of all) byStage[s.lifecycleStage]++;
    const reviews = await this.graph.get<{ value: ListItem<{ SpecId: string; ReviewJson: string; OpenBlockers: number }>[] }>(`${this.listPath('reviews')}?$expand=fields&$filter=fields/OpenBlockers gt 0`);
    const openBlockers: DashboardSnapshot['openBlockers'] = [];
    const pendingReviews: DashboardSnapshot['pendingReviews'] = [];
    for (const it of reviews.value) {
      const spec = all.find((s) => s.id === it.fields.SpecId); if (!spec) continue;
      const review: Review = JSON.parse(it.fields.ReviewJson);
      for (const f of review.findings) if (f.status === 'open' && f.severity === 'blocker') openBlockers.push({ spec, finding: f });
      if (spec.lifecycleStage === 'Review') pendingReviews.push({ spec, review });
    }
    const pending = await this.graph.get<{ value: ListItem<{ SpecId: string; Version: string; ApprovalJson: string }>[] }>(`${this.listPath('approvals')}?$expand=fields&$filter=fields/Status eq 'pending'`);
    const byKey = new Map<string, Approval[]>();
    for (const it of pending.value) { const k = it.fields.SpecId; byKey.set(k, [...(byKey.get(k) ?? []), JSON.parse(it.fields.ApprovalJson)]); }
    const certificationQueue = [...byKey.entries()].flatMap(([id, approvals]) => { const spec = all.find((s) => s.id === id); return spec && (spec.lifecycleStage === 'Review' || spec.lifecycleStage === 'Certified') ? [{ spec, approvals }] : []; });
    return { byStage, openBlockers, pendingReviews, certificationQueue, recentlyModified: [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10) };
  }

  async productAreas() { return [...new Set((await this.list({ pageSize: 999 })).items.map((s) => s.productArea))].sort(); }
  async tags() { return [...new Set((await this.list({ pageSize: 999 })).items.flatMap((s) => s.tags))].sort(); }

  async get(id: string) { return this.toSpec(await this.findSpecItem(id)); }

  async getVersion(id: string, version?: string): Promise<SpecificationVersion> {
    const item = await this.findSpecItem(id);
    const current: SpecificationVersion = JSON.parse(item.fields.ModelJson);
    if (!version || version === current.version) return { ...current, etag: item.eTag ?? current.etag };
    const model = await this.graph.get<string>(this.docPath(id, version, 'model.json'));
    return typeof model === 'string' ? JSON.parse(model) : (model as SpecificationVersion);
  }

  async listVersions(id: string) {
    const r = await this.graph.get<{ value: { name: string; createdDateTime: string; createdBy: { user: { id: string; displayName: string; email?: string } } }[] }>(`/drives/${this.cfg.driveId}/root:/${id}:/children`);
    return r.value.filter((f) => f.name.startsWith('v')).map((f) => ({ version: f.name.slice(1), createdAt: f.createdDateTime, createdBy: { id: f.createdBy.user.id, displayName: f.createdBy.user.displayName, email: f.createdBy.user.email ?? '' } }));
  }

  private async writeVersionFiles(v: SpecificationVersion) {
    await Promise.all([
      this.graph.putContent(this.docPath(v.specId, v.version, 'spec.md'), v.markdown, 'text/markdown'),
      this.graph.putContent(this.docPath(v.specId, v.version, 'manifest.yaml'), v.manifestYaml, 'application/yaml'),
      this.graph.putContent(this.docPath(v.specId, v.version, 'model.json'), JSON.stringify(v), 'application/json'),
    ]);
  }

  async create(input: NewSpecification, actor: UserRef): Promise<Specification> {
    const existing = await this.list({ productArea: [input.productArea], pageSize: 999 });
    const id = specIdFor(input.productArea, existing.total + 1);
    const at = nowIso();
    const spec: Specification = { id, title: input.title, productArea: input.productArea, status: 'Active', lifecycleStage: 'Draft', owner: input.owner, contributors: [], tags: input.tags ?? [], currentVersion: '0.1', completion: 0, createdAt: at, updatedAt: at, updatedBy: actor, dataClassification: input.dataClassification ?? 'internal', certificationStale: false };
    const sections = emptySections();
    const v: SpecificationVersion = { specId: id, version: '0.1', sections, markdown: '', manifestYaml: '', etag: '', createdAt: at, createdBy: actor };
    v.markdown = renderMarkdown({ spec, version: '0.1', sections }); v.manifestYaml = renderManifestYaml({ spec, version: '0.1', sections });
    await this.graph.post(this.listPath('specifications'), { fields: this.toFields(spec, v) });
    await this.writeVersionFiles(v);
    for (const type of APPROVAL_TYPES) { const a: Approval = { id: uid('apr'), specId: id, version: '0.1', type, status: 'pending', evidence: [] }; await this.graph.post(this.listPath('approvals'), { fields: { Title: a.id, SpecId: id, Version: '0.1', ApprovalType: type, Status: 'pending', ApprovalJson: JSON.stringify(a) } }); }
    await this.appendAudit({ specId: id, version: '0.1', action: 'created', actor, summary: `Created ${id} “${spec.title}”` });
    return spec;
  }

  async saveSection<K extends SectionKey>(args: { id: string; version: string; key: K; content: SectionContentMap[K]; etag: string; actor: UserRef; source?: 'human' | 'ai' }): Promise<SpecificationVersion> {
    const item = await this.findSpecItem(args.id);
    if (item.eTag && args.etag && item.eTag !== args.etag) throw new ConcurrencyError(item.eTag);
    const spec = this.toSpec(item);
    let v: SpecificationVersion = JSON.parse(item.fields.ModelJson);
    if (spec.lifecycleStage === 'Certified' || spec.lifecycleStage === 'In Delivery') {
      v = { ...v, version: bumpVersion(v.version, 'save'), createdAt: nowIso(), createdBy: args.actor, certifiedAt: undefined };
      spec.currentVersion = v.version; spec.lifecycleStage = 'Draft'; spec.certificationStale = true;
      for (const type of APPROVAL_TYPES) { const a: Approval = { id: uid('apr'), specId: spec.id, version: v.version, type, status: 'pending', evidence: [] }; await this.graph.post(this.listPath('approvals'), { fields: { Title: a.id, SpecId: spec.id, Version: v.version, ApprovalType: type, Status: 'pending', ApprovalJson: JSON.stringify(a) } }); }
    }
    v.sections = withSection(v.sections, args.key, args.content, { lastEditedBy: args.actor, lastEditedAt: nowIso(), source: args.source ?? 'human' });
    spec.completion = overallCompletion(v.sections); spec.updatedAt = nowIso(); spec.updatedBy = args.actor;
    const approvals = await this.listApprovals(spec.id, v.version);
    v.markdown = renderMarkdown({ spec, version: v.version, sections: v.sections });
    v.manifestYaml = renderManifestYaml({ spec, version: v.version, sections: v.sections, approvals });
    const updated = await this.graph.patch<{ '@odata.etag'?: string }>(`${this.listPath('specifications')}/${item.id}/fields`, this.toFields(spec, v), item.eTag);
    await this.writeVersionFiles(v);
    await this.appendAudit({ specId: spec.id, version: v.version, action: 'section.updated', actor: args.actor, summary: `Updated ${args.key}${args.source === 'ai' ? ' from AI proposal' : ''}` });
    return { ...v, etag: updated?.['@odata.etag'] ?? (await this.findSpecItem(spec.id)).eTag ?? '' };
  }

  async updateHeader(id: string, patch: Partial<Pick<Specification, 'title' | 'productArea' | 'status' | 'tags' | 'contributors' | 'owner'>>, actor: UserRef) {
    const item = await this.findSpecItem(id);
    const spec = { ...this.toSpec(item), ...patch, updatedAt: nowIso(), updatedBy: actor };
    await this.graph.patch(`${this.listPath('specifications')}/${item.id}/fields`, this.toFields(spec), item.eTag);
    return spec;
  }

  async promote(id: string, to: LifecycleStage, actor: UserRef, reason?: string): Promise<Specification> {
    const item = await this.findSpecItem(id);
    const spec = this.toSpec(item);
    const v: SpecificationVersion = JSON.parse(item.fields.ModelJson);
    const approvals = await this.listApprovals(id, v.version);
    const openBlockers = (await this.listReviews(id)).flatMap((r) => r.findings).filter((f) => f.status === 'open' && f.severity === 'blocker');
    const evaluation = evaluateTransition(to, { spec, productIntentComplete: v.sections.productIntent.completion === 'complete', openBlockers, approvals, hasDeliveryPack: !!(await this.getPack(id, v.version)), hasReleaseEvidence: approvals.some((a) => a.evidence.length > 0) || spec.lifecycleStage === 'In Delivery', reason });
    if (!evaluation.allowed) throw new GuardError(`Cannot move ${spec.lifecycleStage} → ${to}`, evaluation.checks);
    const from = spec.lifecycleStage;
    spec.lifecycleStage = to; spec.updatedAt = nowIso(); spec.updatedBy = actor;
    if (to === 'Certified') { v.certifiedAt = nowIso(); v.version = bumpVersion(v.version, 'certify'); spec.currentVersion = v.version; spec.certificationStale = false; }
    v.manifestYaml = renderManifestYaml({ spec, version: v.version, sections: v.sections, approvals });
    await this.graph.patch(`${this.listPath('specifications')}/${item.id}/fields`, this.toFields(spec, v), item.eTag);
    if (to === 'Certified') await this.writeVersionFiles(v);
    await this.appendAudit({ specId: id, version: v.version, action: evaluation.kind === 'promote' ? 'stage.promoted' : 'stage.demoted', actor, summary: `${from} → ${to}${reason ? `: ${reason}` : ''}`, before: from, after: to });
    return spec;
  }

  async listReviews(id: string): Promise<Review[]> {
    const r = await this.graph.get<{ value: ListItem<{ ReviewJson: string }>[] }>(`${this.listPath('reviews')}?$expand=fields($select=ReviewJson)&$filter=fields/SpecId eq '${id}'`);
    return r.value.map((i) => JSON.parse(i.fields.ReviewJson));
  }
  async saveReview(review: Review): Promise<Review> {
    const open = review.findings.filter((f) => f.status === 'open');
    const fields = { Title: review.id, SpecId: review.specId, Version: review.version, Kind: review.kind, Status: review.status, OpenBlockers: open.filter((f) => f.severity === 'blocker').length, ReviewJson: JSON.stringify(review) };
    const r = await this.graph.get<{ value: ListItem<unknown>[] }>(`${this.listPath('reviews')}?$filter=fields/Title eq '${review.id}'`);
    if (r.value.length) await this.graph.patch(`${this.listPath('reviews')}/${r.value[0].id}/fields`, fields); else await this.graph.post(this.listPath('reviews'), { fields });
    return review;
  }
  async updateFinding(id: string, reviewId: string, findingId: string, patch: Partial<Finding>, actor: UserRef) {
    const review = (await this.listReviews(id)).find((r) => r.id === reviewId); const f = review?.findings.find((x) => x.id === findingId);
    if (!review || !f) throw new Error('Finding not found');
    Object.assign(f, patch, patch.status && patch.status !== 'open' ? { resolvedBy: actor } : {});
    await this.saveReview(review); return f;
  }

  async listApprovals(id: string, version: string): Promise<Approval[]> {
    const r = await this.graph.get<{ value: ListItem<{ ApprovalJson: string }>[] }>(`${this.listPath('approvals')}?$expand=fields($select=ApprovalJson)&$filter=fields/SpecId eq '${id}' and fields/Version eq '${version}'`);
    return r.value.map((i) => JSON.parse(i.fields.ApprovalJson));
  }
  private async writeApproval(a: Approval) {
    const r = await this.graph.get<{ value: ListItem<unknown>[] }>(`${this.listPath('approvals')}?$filter=fields/Title eq '${a.id}'`);
    const fields = { Title: a.id, SpecId: a.specId, Version: a.version, ApprovalType: a.type, Status: a.status, ApprovalJson: JSON.stringify(a) };
    if (r.value.length) await this.graph.patch(`${this.listPath('approvals')}/${r.value[0].id}/fields`, fields); else await this.graph.post(this.listPath('approvals'), { fields });
  }
  async setApproval(args: { id: string; version: string; type: Approval['type']; status: Approval['status']; actor: UserRef; comment?: string; waiverReason?: string; secondApprover?: UserRef }) {
    const a = (await this.listApprovals(args.id, args.version)).find((x) => x.type === args.type); if (!a) throw new Error('Approval not found');
    Object.assign(a, { status: args.status, approver: args.actor, decidedAt: nowIso(), comment: args.comment, waiverReason: args.waiverReason, secondApprover: args.secondApprover });
    await this.writeApproval(a); await this.appendAudit({ specId: args.id, version: args.version, action: 'approval.set', actor: args.actor, summary: `${args.type} approval set to ${args.status}` }); return a;
  }
  async addEvidence(id: string, approvalId: string, evidence: Omit<Approval['evidence'][number], 'id' | 'addedAt' | 'addedBy'>, actor: UserRef) {
    const spec = await this.get(id); const a = (await this.listApprovals(id, spec.currentVersion)).find((x) => x.id === approvalId); if (!a) throw new Error('Approval not found');
    a.evidence.push({ ...evidence, id: uid('ev'), addedAt: nowIso(), addedBy: actor }); await this.writeApproval(a);
    await this.appendAudit({ specId: id, version: a.version, action: 'evidence.added', actor, summary: `Evidence “${evidence.label}” added to ${a.type}` }); return a;
  }

  async getPack(id: string, version: string): Promise<DeliveryPack | null> {
    const r = await this.graph.get<{ value: ListItem<{ PackJson: string }>[] }>(`${this.listPath('deliverables')}?$expand=fields($select=PackJson)&$filter=fields/SpecId eq '${id}' and fields/Version eq '${version}'`);
    return r.value.length ? JSON.parse(r.value[0].fields.PackJson) : null;
  }
  async savePack(pack: DeliveryPack): Promise<DeliveryPack> {
    const fields = { Title: pack.id, SpecId: pack.specId, Version: pack.version, GeneratedAtIso: pack.generatedAt, ExportedTo: pack.exportedTo ?? '', PackJson: JSON.stringify(pack) };
    const r = await this.graph.get<{ value: ListItem<unknown>[] }>(`${this.listPath('deliverables')}?$filter=fields/SpecId eq '${pack.specId}' and fields/Version eq '${pack.version}'`);
    if (r.value.length) await this.graph.patch(`${this.listPath('deliverables')}/${r.value[0].id}/fields`, fields); else await this.graph.post(this.listPath('deliverables'), { fields });
    await this.graph.putContent(this.docPath(pack.specId, pack.version, 'delivery-pack.json'), JSON.stringify(pack, null, 2), 'application/json');
    await this.appendAudit({ specId: pack.specId, version: pack.version, action: 'pack.generated', actor: pack.generatedBy, summary: `Delivery pack generated (${pack.items.length} items)` });
    return pack;
  }

  async appendAudit(event: Omit<AuditEvent, 'id' | 'at'>): Promise<void> {
    const e: AuditEvent = { ...event, id: uid('aud'), at: nowIso() };
    await this.graph.post(this.listPath('audit'), { fields: { Title: e.id, SpecId: e.specId, Version: e.version, Action: e.action, ActorJson: JSON.stringify(e.actor), AtIso: e.at, Summary: e.summary, BeforeJson: JSON.stringify(e.before ?? null), AfterJson: JSON.stringify(e.after ?? null) } });
  }
  async listAudit(id: string): Promise<AuditEvent[]> {
    const r = await this.graph.get<{ value: ListItem<{ Title: string; SpecId: string; Version: string; Action: string; ActorJson: string; AtIso: string; Summary: string; BeforeJson: string; AfterJson: string }>[] }>(`${this.listPath('audit')}?$expand=fields&$filter=fields/SpecId eq '${id}'&$orderby=fields/AtIso desc`);
    return r.value.map((i) => ({ id: i.fields.Title, specId: i.fields.SpecId, version: i.fields.Version, action: i.fields.Action as AuditEvent['action'], actor: JSON.parse(i.fields.ActorJson), at: i.fields.AtIso, summary: i.fields.Summary, before: JSON.parse(i.fields.BeforeJson || 'null'), after: JSON.parse(i.fields.AfterJson || 'null') }));
  }
}
