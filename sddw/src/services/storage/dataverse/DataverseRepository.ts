import { evaluateTransition, bumpVersion } from '@/domain/lifecycle';
import { renderManifestYaml, renderMarkdown } from '@/domain/manifest';
import { emptySections, overallCompletion, withSection } from '@/domain/sections';
import { nowIso, specIdFor, uid } from '@/domain/ids';
import { APPROVAL_TYPES, LIFECYCLE_STAGES } from '@/domain/types';
import type {
  Approval, AuditEvent, CatalogueQuery, DashboardSnapshot, DeliveryPack, Finding, LifecycleStage, NewSpecification, Page, Review,
  SectionContentMap, SectionKey, Specification, SpecificationSummary, SpecificationVersion, UserRef,
} from '@/domain/types';
import { createHttp, type TokenProvider } from '@/services/http';
import { ConcurrencyError, GuardError, type SpecificationRepository } from '../SpecificationRepository';

/**
 * Dataverse-first adapter (Option B — docs/07-dataverse-design.md).
 * Talks to the Dataverse Web API (OData v4) with the user's delegated token.
 * Table/column names use the `sddw_` publisher prefix. Row versions (`@odata.etag`) drive optimistic concurrency.
 *
 * Server-side rules (approval guard, immutable audit) are expected as Dataverse plug-ins; this adapter
 * re-applies the same domain guards so the UI fails fast.
 */
export interface DataverseConfig { orgUrl: string }

type Row = Record<string, unknown> & { '@odata.etag'?: string };

export class DataverseRepository implements SpecificationRepository {
  private readonly http: ReturnType<typeof createHttp>;
  private readonly api: string;
  private readonly scope: string;
  constructor(getToken: TokenProvider, cfg: DataverseConfig) {
    this.http = createHttp(getToken);
    this.api = `${cfg.orgUrl.replace(/\/$/, '')}/api/data/v9.2`;
    this.scope = `${cfg.orgUrl.replace(/\/$/, '')}/user_impersonation`;
  }
  private headers(extra: Record<string, string> = {}) { return { 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', Prefer: 'return=representation', ...extra }; }
  private odataGet<T>(path: string, extra?: Record<string, string>) { return this.http<T>(`${this.api}${path}`, { scope: this.scope, headers: this.headers(extra) }); }
  private post<T>(path: string, body: unknown) { return this.http<T>(`${this.api}${path}`, { method: 'POST', body, scope: this.scope, headers: this.headers() }); }
  private patch<T>(path: string, body: unknown, etag?: string) { return this.http<T>(`${this.api}${path}`, { method: 'PATCH', body, scope: this.scope, headers: this.headers(etag ? { 'If-Match': etag } : {}) }); }

  private toSpec(r: Row): Specification {
    return {
      id: r.sddw_specid as string, title: r.sddw_title as string, productArea: r.sddw_productarealabel as string, status: r.sddw_statuslabel as Specification['status'],
      lifecycleStage: r.sddw_lifecyclestagelabel as LifecycleStage, owner: JSON.parse(r.sddw_ownerjson as string), contributors: JSON.parse((r.sddw_contributorsjson as string) || '[]'),
      tags: ((r.sddw_tags as string) ?? '').split(';').filter(Boolean), currentVersion: r.sddw_currentversion as string, completion: (r.sddw_completion as number) ?? 0,
      createdAt: r.createdon as string, updatedAt: r.modifiedon as string, updatedBy: JSON.parse((r.sddw_updatedbyjson as string) || 'null') ?? JSON.parse(r.sddw_ownerjson as string),
      dataClassification: (r.sddw_dataclassificationlabel as Specification['dataClassification']) ?? 'internal', certificationStale: !!r.sddw_certificationstale,
    };
  }
  private toRow(s: Specification): Row {
    return { sddw_specid: s.id, sddw_title: s.title, sddw_productarealabel: s.productArea, sddw_statuslabel: s.status, sddw_lifecyclestagelabel: s.lifecycleStage, sddw_ownerjson: JSON.stringify(s.owner), sddw_contributorsjson: JSON.stringify(s.contributors), sddw_tags: s.tags.join(';'), sddw_currentversion: s.currentVersion, sddw_completion: s.completion, sddw_updatedbyjson: JSON.stringify(s.updatedBy), sddw_dataclassificationlabel: s.dataClassification, sddw_certificationstale: s.certificationStale };
  }
  private async specRow(id: string): Promise<Row & { sddw_specificationid: string }> {
    const r = await this.odataGet<{ value: (Row & { sddw_specificationid: string })[] }>(`/sddw_specifications?$filter=sddw_specid eq '${id}'&$top=1`);
    if (!r.value.length) throw new Error(`Specification ${id} not found`);
    return r.value[0];
  }
  private async versionRow(specGuid: string, version: string) {
    const r = await this.odataGet<{ value: (Row & { sddw_specificationversionid: string; sddw_modeljson: string })[] }>(`/sddw_specificationversions?$filter=_sddw_specification_value eq ${specGuid} and sddw_version eq '${version}'&$top=1`);
    if (!r.value.length) throw new Error(`Version ${version} not found`);
    return r.value[0];
  }

  async list(q: CatalogueQuery): Promise<Page<SpecificationSummary>> {
    const f: string[] = [];
    if (q.search) f.push(`(contains(sddw_title,'${q.search.replace(/'/g, "''")}') or contains(sddw_specid,'${q.search.replace(/'/g, "''")}'))`);
    if (q.lifecycleStage?.length) f.push(`(${q.lifecycleStage.map((s) => `sddw_lifecyclestagelabel eq '${s}'`).join(' or ')})`);
    if (q.productArea?.length) f.push(`(${q.productArea.map((s) => `sddw_productarealabel eq '${s}'`).join(' or ')})`);
    if (q.status?.length) f.push(`(${q.status.map((s) => `sddw_statuslabel eq '${s}'`).join(' or ')})`);
    if (q.tag?.length) f.push(`(${q.tag.map((t) => `contains(sddw_tags,'${t}')`).join(' or ')})`);
    const sortField: Record<string, string> = { updatedAt: 'modifiedon', title: 'sddw_title', id: 'sddw_specid', lifecycleStage: 'sddw_lifecyclestagelabel', completion: 'sddw_completion', productArea: 'sddw_productarealabel' };
    const sort = q.sort ?? { field: 'updatedAt', dir: 'desc' };
    const page = q.page ?? 1, pageSize = q.pageSize ?? 25;
    const r = await this.odataGet<{ value: Row[]; '@odata.count': number }>(`/sddw_specifications?$count=true${f.length ? `&$filter=${encodeURIComponent(f.join(' and '))}` : ''}&$orderby=${sortField[sort.field as string] ?? 'modifiedon'} ${sort.dir}&$top=${pageSize}&$skip=${(page - 1) * pageSize}`);
    let items = r.value.map((x) => this.toSpec(x));
    if (q.owner?.length) items = items.filter((i) => q.owner!.includes(i.owner.id));
    return { items, total: r['@odata.count'], page, pageSize };
  }

  async dashboard(filter?: { productArea?: string }): Promise<DashboardSnapshot> {
    const all = (await this.list({ pageSize: 5000, productArea: filter?.productArea ? [filter.productArea] : undefined })).items;
    const byStage = Object.fromEntries(LIFECYCLE_STAGES.map((s) => [s, 0])) as Record<LifecycleStage, number>;
    for (const s of all) byStage[s.lifecycleStage]++;
    const blockers = await this.odataGet<{ value: (Row & { sddw_findingjson: string; sddw_specid: string })[] }>(`/sddw_findings?$filter=sddw_statuslabel eq 'open' and sddw_severitylabel eq 'blocker'&$select=sddw_findingjson,sddw_specid`);
    const openBlockers = blockers.value.flatMap((b) => { const spec = all.find((s) => s.id === b.sddw_specid); return spec ? [{ spec, finding: JSON.parse(b.sddw_findingjson) as Finding }] : []; });
    const reviews = await this.odataGet<{ value: (Row & { sddw_reviewjson: string; sddw_specid: string })[] }>(`/sddw_reviews?$filter=sddw_openfindings gt 0&$select=sddw_reviewjson,sddw_specid`);
    const pendingReviews = reviews.value.flatMap((r) => { const spec = all.find((s) => s.id === r.sddw_specid); return spec && spec.lifecycleStage === 'Review' ? [{ spec, review: JSON.parse(r.sddw_reviewjson) as Review }] : []; });
    const pend = await this.odataGet<{ value: (Row & { sddw_approvaljson: string; sddw_specid: string })[] }>(`/sddw_approvals?$filter=sddw_statuslabel eq 'pending'&$select=sddw_approvaljson,sddw_specid`);
    const byId = new Map<string, Approval[]>();
    for (const a of pend.value) byId.set(a.sddw_specid, [...(byId.get(a.sddw_specid) ?? []), JSON.parse(a.sddw_approvaljson)]);
    const certificationQueue = [...byId.entries()].flatMap(([id, approvals]) => { const spec = all.find((s) => s.id === id); return spec && (spec.lifecycleStage === 'Review' || spec.lifecycleStage === 'Certified') && spec.currentVersion === approvals[0]?.version ? [{ spec, approvals }] : []; });
    return { byStage, openBlockers, pendingReviews, certificationQueue, recentlyModified: [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10) };
  }
  async productAreas() { const r = await this.odataGet<{ value: { sddw_productarealabel: string }[] }>(`/sddw_specifications?$select=sddw_productarealabel&$apply=groupby((sddw_productarealabel))`); return r.value.map((x) => x.sddw_productarealabel).sort(); }
  async tags() { const r = await this.odataGet<{ value: { sddw_tags: string }[] }>(`/sddw_specifications?$select=sddw_tags`); return [...new Set(r.value.flatMap((x) => (x.sddw_tags ?? '').split(';').filter(Boolean)))].sort(); }

  async get(id: string) { return this.toSpec(await this.specRow(id)); }
  async getVersion(id: string, version?: string): Promise<SpecificationVersion> {
    const s = await this.specRow(id);
    const vr = await this.versionRow(s.sddw_specificationid, version ?? (s.sddw_currentversion as string));
    return { ...(JSON.parse(vr.sddw_modeljson) as SpecificationVersion), etag: vr['@odata.etag'] ?? '' };
  }
  async listVersions(id: string) {
    const s = await this.specRow(id);
    const r = await this.odataGet<{ value: Row[] }>(`/sddw_specificationversions?$filter=_sddw_specification_value eq ${s.sddw_specificationid}&$select=sddw_version,createdon,sddw_createdbyjson,sddw_certifiedon&$orderby=createdon desc`);
    return r.value.map((v) => ({ version: v.sddw_version as string, createdAt: v.createdon as string, createdBy: JSON.parse(v.sddw_createdbyjson as string), certifiedAt: (v.sddw_certifiedon as string | undefined) ?? undefined }));
  }

  private async writeVersion(specGuid: string, v: SpecificationVersion, existingId?: string, etag?: string) {
    const body = { sddw_version: v.version, sddw_modeljson: JSON.stringify(v), sddw_markdown: v.markdown, sddw_manifestyaml: v.manifestYaml, sddw_createdbyjson: JSON.stringify(v.createdBy), sddw_certifiedon: v.certifiedAt ?? null, ...(existingId ? {} : { 'sddw_specification@odata.bind': `/sddw_specifications(${specGuid})` }) };
    return existingId ? this.patch<Row>(`/sddw_specificationversions(${existingId})`, body, etag) : this.post<Row>('/sddw_specificationversions', body);
  }
  private async createApprovals(specGuid: string, specId: string, version: string) {
    for (const type of APPROVAL_TYPES) { const a: Approval = { id: uid('apr'), specId, version, type, status: 'pending', evidence: [] }; await this.post('/sddw_approvals', { sddw_approvalkey: a.id, sddw_specid: specId, sddw_version: version, sddw_typelabel: type, sddw_statuslabel: 'pending', sddw_approvaljson: JSON.stringify(a), 'sddw_specification@odata.bind': `/sddw_specifications(${specGuid})` }); }
  }

  async create(input: NewSpecification, actor: UserRef): Promise<Specification> {
    const count = await this.odataGet<{ '@odata.count': number }>(`/sddw_specifications?$count=true&$top=1&$filter=sddw_productarealabel eq '${input.productArea}'`);
    const id = specIdFor(input.productArea, count['@odata.count'] + 1);
    const at = nowIso();
    const spec: Specification = { id, title: input.title, productArea: input.productArea, status: 'Active', lifecycleStage: 'Draft', owner: input.owner, contributors: [], tags: input.tags ?? [], currentVersion: '0.1', completion: 0, createdAt: at, updatedAt: at, updatedBy: actor, dataClassification: input.dataClassification ?? 'internal', certificationStale: false };
    const sections = emptySections();
    const v: SpecificationVersion = { specId: id, version: '0.1', sections, markdown: renderMarkdown({ spec, version: '0.1', sections }), manifestYaml: renderManifestYaml({ spec, version: '0.1', sections }), etag: '', createdAt: at, createdBy: actor };
    const created = await this.post<Row & { sddw_specificationid: string }>('/sddw_specifications', this.toRow(spec));
    await this.writeVersion(created.sddw_specificationid, v);
    await this.createApprovals(created.sddw_specificationid, id, '0.1');
    await this.appendAudit({ specId: id, version: '0.1', action: 'created', actor, summary: `Created ${id} “${spec.title}”` });
    return spec;
  }

  async saveSection<K extends SectionKey>(args: { id: string; version: string; key: K; content: SectionContentMap[K]; etag: string; actor: UserRef; source?: 'human' | 'ai' }): Promise<SpecificationVersion> {
    const s = await this.specRow(args.id);
    const spec = this.toSpec(s);
    let vr = await this.versionRow(s.sddw_specificationid, spec.currentVersion);
    if (args.etag && vr['@odata.etag'] && vr['@odata.etag'] !== args.etag) throw new ConcurrencyError(vr['@odata.etag']);
    let v: SpecificationVersion = JSON.parse(vr.sddw_modeljson);
    let newVersion = false;
    if (spec.lifecycleStage === 'Certified' || spec.lifecycleStage === 'In Delivery') {
      v = { ...v, version: bumpVersion(v.version, 'save'), createdAt: nowIso(), createdBy: args.actor, certifiedAt: undefined };
      spec.currentVersion = v.version; spec.lifecycleStage = 'Draft'; spec.certificationStale = true; newVersion = true;
    }
    v.sections = withSection(v.sections, args.key, args.content, { lastEditedBy: args.actor, lastEditedAt: nowIso(), source: args.source ?? 'human' });
    spec.completion = overallCompletion(v.sections); spec.updatedAt = nowIso(); spec.updatedBy = args.actor;
    v.markdown = renderMarkdown({ spec, version: v.version, sections: v.sections });
    v.manifestYaml = renderManifestYaml({ spec, version: v.version, sections: v.sections, approvals: newVersion ? [] : await this.listApprovals(spec.id, v.version) });
    const saved = newVersion ? await this.writeVersion(s.sddw_specificationid, v) : await this.writeVersion(s.sddw_specificationid, v, vr.sddw_specificationversionid, vr['@odata.etag']);
    if (newVersion) await this.createApprovals(s.sddw_specificationid, spec.id, v.version);
    await this.patch(`/sddw_specifications(${s.sddw_specificationid})`, this.toRow(spec), s['@odata.etag']);
    await this.appendAudit({ specId: spec.id, version: v.version, action: 'section.updated', actor: args.actor, summary: `Updated ${args.key}${args.source === 'ai' ? ' from AI proposal' : ''}` });
    vr = saved as typeof vr;
    return { ...v, etag: saved['@odata.etag'] ?? '' };
  }

  async updateHeader(id: string, patch: Partial<Pick<Specification, 'title' | 'productArea' | 'status' | 'tags' | 'contributors' | 'owner'>>, actor: UserRef) {
    const s = await this.specRow(id); const spec = { ...this.toSpec(s), ...patch, updatedAt: nowIso(), updatedBy: actor };
    await this.patch(`/sddw_specifications(${s.sddw_specificationid})`, this.toRow(spec), s['@odata.etag']); return spec;
  }

  async promote(id: string, to: LifecycleStage, actor: UserRef, reason?: string): Promise<Specification> {
    const s = await this.specRow(id); const spec = this.toSpec(s);
    const vr = await this.versionRow(s.sddw_specificationid, spec.currentVersion); const v: SpecificationVersion = JSON.parse(vr.sddw_modeljson);
    const approvals = await this.listApprovals(id, v.version);
    const openBlockers = (await this.listReviews(id)).flatMap((r) => r.findings).filter((f) => f.status === 'open' && f.severity === 'blocker');
    const evaluation = evaluateTransition(to, { spec, productIntentComplete: v.sections.productIntent.completion === 'complete', openBlockers, approvals, hasDeliveryPack: !!(await this.getPack(id, v.version)), hasReleaseEvidence: approvals.some((a) => a.evidence.length > 0) || spec.lifecycleStage === 'In Delivery', reason });
    if (!evaluation.allowed) throw new GuardError(`Cannot move ${spec.lifecycleStage} → ${to}`, evaluation.checks);
    const from = spec.lifecycleStage; spec.lifecycleStage = to; spec.updatedAt = nowIso(); spec.updatedBy = actor;
    if (to === 'Certified') { v.certifiedAt = nowIso(); v.version = bumpVersion(v.version, 'certify'); spec.currentVersion = v.version; spec.certificationStale = false; }
    v.manifestYaml = renderManifestYaml({ spec, version: v.version, sections: v.sections, approvals });
    await this.writeVersion(s.sddw_specificationid, v, vr.sddw_specificationversionid, vr['@odata.etag']);
    await this.patch(`/sddw_specifications(${s.sddw_specificationid})`, this.toRow(spec), s['@odata.etag']);
    await this.appendAudit({ specId: id, version: v.version, action: evaluation.kind === 'promote' ? 'stage.promoted' : 'stage.demoted', actor, summary: `${from} → ${to}${reason ? `: ${reason}` : ''}`, before: from, after: to });
    return spec;
  }

  async listReviews(id: string): Promise<Review[]> { const r = await this.odataGet<{ value: { sddw_reviewjson: string }[] }>(`/sddw_reviews?$filter=sddw_specid eq '${id}'&$select=sddw_reviewjson&$orderby=createdon asc`); return r.value.map((x) => JSON.parse(x.sddw_reviewjson)); }
  async saveReview(review: Review): Promise<Review> {
    const s = await this.specRow(review.specId);
    const open = review.findings.filter((f) => f.status === 'open');
    const body = { sddw_reviewkey: review.id, sddw_specid: review.specId, sddw_version: review.version, sddw_kindlabel: review.kind, sddw_statuslabel: review.status, sddw_openfindings: open.length, sddw_openblockers: open.filter((f) => f.severity === 'blocker').length, sddw_correlationid: review.correlationId, sddw_agentversion: review.agentVersion ?? '', sddw_reviewjson: JSON.stringify(review) };
    const ex = await this.odataGet<{ value: { sddw_reviewid: string }[] }>(`/sddw_reviews?$filter=sddw_reviewkey eq '${review.id}'&$select=sddw_reviewid`);
    if (ex.value.length) await this.patch(`/sddw_reviews(${ex.value[0].sddw_reviewid})`, body); else await this.post('/sddw_reviews', { ...body, 'sddw_specification@odata.bind': `/sddw_specifications(${s.sddw_specificationid})` });
    // denormalised findings for dashboard queries
    for (const f of review.findings) {
      const fx = await this.odataGet<{ value: { sddw_findingid: string }[] }>(`/sddw_findings?$filter=sddw_findingkey eq '${f.id}'&$select=sddw_findingid`);
      const fb = { sddw_findingkey: f.id, sddw_specid: review.specId, sddw_categorylabel: f.category, sddw_severitylabel: f.severity, sddw_statuslabel: f.status, sddw_sectionkey: f.sectionKey, sddw_title: f.title, sddw_findingjson: JSON.stringify(f) };
      if (fx.value.length) await this.patch(`/sddw_findings(${fx.value[0].sddw_findingid})`, fb); else await this.post('/sddw_findings', fb);
    }
    return review;
  }
  async updateFinding(id: string, reviewId: string, findingId: string, patch: Partial<Finding>, actor: UserRef) {
    const review = (await this.listReviews(id)).find((r) => r.id === reviewId); const f = review?.findings.find((x) => x.id === findingId);
    if (!review || !f) throw new Error('Finding not found');
    Object.assign(f, patch, patch.status && patch.status !== 'open' ? { resolvedBy: actor } : {}); await this.saveReview(review); return f;
  }

  async listApprovals(id: string, version: string): Promise<Approval[]> { const r = await this.odataGet<{ value: { sddw_approvaljson: string }[] }>(`/sddw_approvals?$filter=sddw_specid eq '${id}' and sddw_version eq '${version}'&$select=sddw_approvaljson`); return r.value.map((x) => JSON.parse(x.sddw_approvaljson)); }
  private async writeApproval(a: Approval) {
    const ex = await this.odataGet<{ value: { sddw_approvalid: string }[] }>(`/sddw_approvals?$filter=sddw_approvalkey eq '${a.id}'&$select=sddw_approvalid`);
    if (!ex.value.length) throw new Error('Approval not found');
    await this.patch(`/sddw_approvals(${ex.value[0].sddw_approvalid})`, { sddw_statuslabel: a.status, sddw_approverjson: JSON.stringify(a.approver ?? null), sddw_decidedon: a.decidedAt ?? null, sddw_approvaljson: JSON.stringify(a) });
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

  async getPack(id: string, version: string): Promise<DeliveryPack | null> { const r = await this.odataGet<{ value: { sddw_packjson: string }[] }>(`/sddw_deliverypacks?$filter=sddw_specid eq '${id}' and sddw_version eq '${version}'&$select=sddw_packjson&$top=1`); return r.value.length ? JSON.parse(r.value[0].sddw_packjson) : null; }
  async savePack(pack: DeliveryPack): Promise<DeliveryPack> {
    const s = await this.specRow(pack.specId);
    const body = { sddw_packkey: pack.id, sddw_specid: pack.specId, sddw_version: pack.version, sddw_generatedon: pack.generatedAt, sddw_exportedto: pack.exportedTo ?? '', sddw_itemcount: pack.items.length, sddw_packjson: JSON.stringify(pack) };
    const ex = await this.odataGet<{ value: { sddw_deliverypackid: string }[] }>(`/sddw_deliverypacks?$filter=sddw_specid eq '${pack.specId}' and sddw_version eq '${pack.version}'&$select=sddw_deliverypackid`);
    if (ex.value.length) await this.patch(`/sddw_deliverypacks(${ex.value[0].sddw_deliverypackid})`, body); else await this.post('/sddw_deliverypacks', { ...body, 'sddw_specification@odata.bind': `/sddw_specifications(${s.sddw_specificationid})` });
    await this.appendAudit({ specId: pack.specId, version: pack.version, action: 'pack.generated', actor: pack.generatedBy, summary: `Delivery pack generated (${pack.items.length} items)` });
    return pack;
  }

  async appendAudit(event: Omit<AuditEvent, 'id' | 'at'>): Promise<void> {
    const e: AuditEvent = { ...event, id: uid('aud'), at: nowIso() };
    await this.post('/sddw_auditevents', { sddw_auditkey: e.id, sddw_specid: e.specId, sddw_version: e.version, sddw_actionlabel: e.action, sddw_actorjson: JSON.stringify(e.actor), sddw_on: e.at, sddw_summary: e.summary, sddw_beforejson: JSON.stringify(e.before ?? null), sddw_afterjson: JSON.stringify(e.after ?? null) });
  }
  async listAudit(id: string): Promise<AuditEvent[]> {
    const r = await this.odataGet<{ value: Row[] }>(`/sddw_auditevents?$filter=sddw_specid eq '${id}'&$orderby=sddw_on desc`);
    return r.value.map((x) => ({ id: x.sddw_auditkey as string, specId: x.sddw_specid as string, version: x.sddw_version as string, action: x.sddw_actionlabel as AuditEvent['action'], actor: JSON.parse(x.sddw_actorjson as string), at: x.sddw_on as string, summary: x.sddw_summary as string, before: JSON.parse((x.sddw_beforejson as string) || 'null'), after: JSON.parse((x.sddw_afterjson as string) || 'null') }));
  }
}
