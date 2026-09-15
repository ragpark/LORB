import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { clsx } from 'clsx';
import { usePrincipal } from '@/app/providers';
import { useApprovals, useAudit, usePack, usePromote, useReviews, useSaveSection, useSpecification, useVersion } from '@/features/hooks';
import { Badge, Button, Card, Dialog, ProgressBar, Spinner, Tabs, Textarea } from '@/components/nebula';
import { CompletionDot, StagePill, relTime } from '@/components/StagePill';
import { SECTION_DEFINITIONS, SECTION_GROUPS, groupCompletion, sectionsForGroup } from '@/domain/sections';
import { evaluateTransition, nextStage, previousStage } from '@/domain/lifecycle';
import { canEdit as canEditFn, canPromote } from '@/domain/authorization';
import type { LifecycleStage, SectionContentMap, SectionKey } from '@/domain/types';
import { ConcurrencyError, GuardError } from '@/services/storage/SpecificationRepository';
import { SectionEditor } from './editors';
import { AssistantPanel } from '@/features/assistant/AssistantPanel';

type Tab = 'sections' | 'markdown' | 'manifest' | 'history' | 'audit';

export function SpecificationPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const spec = useSpecification(id); const version = useVersion(id);
  const [tab, setTab] = useState<Tab>('sections');
  const sectionKey = (params.get('section') as SectionKey) || 'productIntent';
  const principal = usePrincipal();
  if (spec.isLoading || version.isLoading || !spec.data || !version.data) return <Spinner label="Loading specification" />;
  const s = spec.data, v = version.data;
  const editable = canEditFn(principal, s);
  return (
    <div className="space-y-4">
      <SpecHeader spec={s} versionLabel={v.version} canPromote={canPromote(principal, s)} />
      <Tabs ariaLabel="Specification views" value={tab} onChange={setTab} tabs={[{ id: 'sections', label: 'Sections' }, { id: 'markdown', label: 'Markdown' }, { id: 'manifest', label: 'Manifest' }, { id: 'history', label: 'History' }, { id: 'audit', label: 'Audit' }]} />
      {tab === 'sections' && (
        <div className="grid gap-4 lg:grid-cols-[14rem_1fr_18rem]">
          <SectionNav sections={v.sections} active={sectionKey} completion={s.completion} onSelect={(k) => { const p = new URLSearchParams(params); p.set('section', k); setParams(p); }} />
          <SectionPane key={`${sectionKey}:${v.version}`} specId={id} version={v} sectionKey={sectionKey} editable={editable} />
          <AssistantPanel spec={s} version={v} sectionKey={sectionKey} canEdit={editable} />
        </div>
      )}
      {tab === 'markdown' && <Card title={`spec.md — v${v.version}`} actions={<Badge tone="neutral">read-only, generated</Badge>}><pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap text-xs leading-5">{v.markdown}</pre></Card>}
      {tab === 'manifest' && <Card title={`manifest.yaml — v${v.version}`} actions={<Badge tone="neutral">read-only, generated</Badge>}><pre className="max-h-[70vh] overflow-auto text-xs leading-5">{v.manifestYaml}</pre></Card>}
      {tab === 'history' && <HistoryTab id={id} />}
      {tab === 'audit' && <AuditTab id={id} />}
    </div>
  );
}

function SpecHeader({ spec, versionLabel, canPromote: allowed }: { spec: NonNullable<ReturnType<typeof useSpecification>['data']>; versionLabel: string; canPromote: boolean }) {
  const [dlg, setDlg] = useState<LifecycleStage | null>(null);
  const up = nextStage(spec.lifecycleStage), down = previousStage(spec.lifecycleStage);
  return (
    <header className="rounded-nebula border border-surface-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs text-ink-muted"><Link to="/specs" className="hover:underline">Catalogue</Link> / {spec.id}</div>
          <h1 className="text-xl font-semibold">{spec.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-ink-muted">
            <span>Owner <strong className="text-ink">{spec.owner.displayName}</strong></span>
            <span>Contributors {spec.contributors.length ? spec.contributors.map((c) => c.displayName).join(', ') : '—'}</span>
            <span>Area <strong className="text-ink">{spec.productArea}</strong></span>
            <span>Status {spec.status}</span>
            <span>Updated {relTime(spec.updatedAt)} by {spec.updatedBy.displayName}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">v{versionLabel}</Badge>
          <StagePill stage={spec.lifecycleStage} />
          {spec.certificationStale && <Badge tone="warning">certification stale</Badge>}
          <ProgressBar value={spec.completion} label="Overall completion" />
          <Link to={`/specs/${spec.id}/review`}><Button size="sm">Review</Button></Link>
          <Link to={`/specs/${spec.id}/certification`}><Button size="sm">Certification</Button></Link>
          <Link to={`/specs/${spec.id}/delivery`}><Button size="sm">Delivery pack</Button></Link>
          {up && <Button size="sm" variant="primary" disabled={!allowed} onClick={() => setDlg(up)}>Promote to {up}</Button>}
          {down && <Button size="sm" variant="ghost" disabled={!allowed} onClick={() => setDlg(down)}>Return to {down}</Button>}
        </div>
      </div>
      {dlg && <PromotionDialog specId={spec.id} to={dlg} onClose={() => setDlg(null)} />}
    </header>
  );
}

function PromotionDialog({ specId, to, onClose }: { specId: string; to: LifecycleStage; onClose: () => void }) {
  const spec = useSpecification(specId); const version = useVersion(specId); const reviews = useReviews(specId);
  const approvals = useApprovals(specId, spec.data?.currentVersion ?? ''); const pack = usePack(specId, spec.data?.currentVersion ?? '');
  const promote = usePromote(specId);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const evaluation = useMemo(() => {
    if (!spec.data || !version.data) return null;
    const openBlockers = (reviews.data ?? []).flatMap((r) => r.findings).filter((f) => f.status === 'open' && f.severity === 'blocker');
    return evaluateTransition(to, { spec: spec.data, productIntentComplete: version.data.sections.productIntent.completion === 'complete', openBlockers, approvals: approvals.data ?? [], hasDeliveryPack: !!pack.data, hasReleaseEvidence: (approvals.data ?? []).some((a) => a.evidence.length > 0) || spec.data.lifecycleStage === 'In Delivery', reason });
  }, [spec.data, version.data, reviews.data, approvals.data, pack.data, to, reason]);
  const needsReason = evaluation?.kind === 'demote' || to === 'Retired';
  return (
    <Dialog open title={`${evaluation?.kind === 'demote' ? 'Return' : 'Promote'} to ${to}`} onClose={onClose} footer={<><Button onClick={onClose}>Close</Button><Button variant="primary" disabled={!evaluation?.allowed || promote.isPending} onClick={async () => { try { await promote.mutateAsync({ to, reason: reason || undefined }); onClose(); } catch (e) { setError(e instanceof GuardError ? e.message : (e as Error).message); } }}>Confirm</Button></>}>
      {!evaluation ? <Spinner /> : (
        <div className="space-y-3">
          <ul className="space-y-1">{evaluation.checks.map((c) => <li key={c.label} className={clsx('flex items-center gap-2 text-sm', c.ok ? 'text-emerald-800' : 'text-red-700')}><span aria-hidden>{c.ok ? '✓' : '✕'}</span><span>{c.label}</span>{c.detail && <span className="text-ink-subtle">({c.detail})</span>}</li>)}</ul>
          {needsReason && <label className="block text-sm">Reason<Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1" /></label>}
          {!evaluation.allowed && <p className="text-xs text-ink-muted">The transition is not available until all checks pass. Every promotion is recorded in the audit trail.</p>}
          {error && <p className="text-sm text-red-700">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}

function SectionNav({ sections, active, onSelect, completion }: { sections: NonNullable<ReturnType<typeof useVersion>['data']>['sections']; active: SectionKey; onSelect: (k: SectionKey) => void; completion: number }) {
  return (
    <nav aria-label="Sections" className="rounded-nebula border border-surface-line bg-surface p-2">
      <div className="flex items-center justify-between px-2 py-1 text-xs font-semibold uppercase tracking-wide text-ink-muted"><span>Sections</span><span>{completion}%</span></div>
      {SECTION_GROUPS.map((g) => (
        <div key={g} className="mt-1">
          <div className="flex items-center justify-between px-2 py-1 text-sm font-semibold"><span>{g}</span><span className="text-xs text-ink-muted">{groupCompletion(sections, g)}%</span></div>
          <ul>{sectionsForGroup(g).map((k) => (
            <li key={k}><button onClick={() => onSelect(k)} aria-current={active === k ? 'page' : undefined} className={clsx('flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm', active === k ? 'bg-brand-50 font-medium text-brand-800' : 'text-ink-muted hover:bg-surface-alt hover:text-ink')}>
              <span>{SECTION_DEFINITIONS[k].label}</span><CompletionDot completion={sections[k].completion} /></button></li>
          ))}</ul>
        </div>
      ))}
    </nav>
  );
}

/** Autosaving structured editor for one section (FR-EDIT-3/4). */
function SectionPane({ specId, version, sectionKey, editable }: { specId: string; version: NonNullable<ReturnType<typeof useVersion>['data']>; sectionKey: SectionKey; editable: boolean }) {
  const section = version.sections[sectionKey];
  const [draft, setDraft] = useState<SectionContentMap[SectionKey]>(section.content);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const save = useSaveSection(specId);
  const timer = useRef<number | undefined>(undefined);
  const etag = useRef(version.etag);
  useEffect(() => { etag.current = version.etag; }, [version.etag]);
  const flush = async (content: SectionContentMap[SectionKey]) => {
    try { const v = await save.mutateAsync({ version: version.version, key: sectionKey, content, etag: etag.current }); etag.current = v.etag; setDirty(false); setConflict(null); }
    catch (e) { if (e instanceof ConcurrencyError) setConflict(e.message); else setConflict((e as Error).message); }
  };
  const onChange = (content: SectionContentMap[SectionKey]) => {
    setDraft(content); setDirty(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => flush(content), 900);
  };
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const def = SECTION_DEFINITIONS[sectionKey];
  return (
    <Card title={<span className="flex items-center gap-2">{section.group} › {def.label} <CompletionDot completion={section.completion} /> <span className="text-xs font-normal text-ink-muted">{section.completion}</span></span>}
      actions={<span className="text-xs text-ink-muted" aria-live="polite">{save.isPending ? 'Saving…' : dirty ? 'Unsaved changes' : section.lastEditedAt ? `Saved ${relTime(section.lastEditedAt)}${section.source === 'ai' ? ' · from AI proposal' : ''}` : 'Not yet edited'}</span>}>
      <p className="mb-4 text-sm text-ink-muted">{def.description}</p>
      {!editable && <p className="mb-3 rounded bg-surface-alt p-2 text-xs text-ink-muted">You can view this specification. Only the owner, contributors or an admin can edit it.</p>}
      {conflict && <div role="alert" className="mb-3 flex items-center justify-between rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900"><span>{conflict}</span><Button size="sm" onClick={() => window.location.reload()}>Reload</Button></div>}
      <SectionEditor sectionKey={sectionKey} value={draft} onChange={onChange} disabled={!editable} />
    </Card>
  );
}

function HistoryTab({ id }: { id: string }) {
  const spec = useSpecification(id);
  const [sel, setSel] = useState<string | undefined>(undefined);
  const versions = useVersionsList(id); const v = useVersion(id, sel);
  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <Card title="Versions">
        <ul className="divide-y divide-surface-line">{(versions.data ?? []).map((x) => (
          <li key={x.version}><button onClick={() => setSel(x.version)} className={clsx('w-full px-2 py-2 text-left text-sm hover:bg-surface-alt', (sel ?? spec.data?.currentVersion) === x.version && 'bg-brand-50')}>
            <div className="font-medium">v{x.version} {x.certifiedAt && <Badge tone="success">certified</Badge>}</div><div className="text-xs text-ink-muted">{relTime(x.createdAt)} · {x.createdBy.displayName}</div></button></li>
        ))}</ul>
      </Card>
      <Card title={`spec.md — v${v.data?.version ?? ''}`}>{v.data ? <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap text-xs leading-5">{v.data.markdown}</pre> : <Spinner />}</Card>
    </div>
  );
}
function useVersionsList(id: string) { const repo = useRepositoryHook(); return useQueryHook(['versions', id], () => repo.listVersions(id)); }

function AuditTab({ id }: { id: string }) {
  const audit = useAudit(id);
  return (
    <Card title="Audit trail" actions={<Badge tone="neutral">append-only</Badge>}>
      {!audit.data ? <Spinner /> : (
        <ol className="divide-y divide-surface-line">{audit.data.map((e) => (
          <li key={e.id} className="flex gap-4 py-2 text-sm"><span className="w-24 shrink-0 text-xs text-ink-muted">{relTime(e.at)}</span><Badge tone="neutral" className="shrink-0">{e.action}</Badge><span className="flex-1">{e.summary}</span><span className="text-xs text-ink-muted">{e.actor.displayName} · v{e.version}</span></li>
        ))}</ol>
      )}
    </Card>
  );
}

// Local aliases to keep the imports at the top tidy.
import { useRepository as useRepositoryHook } from '@/app/providers';
import { useQuery } from '@tanstack/react-query';
function useQueryHook<T>(key: readonly unknown[], fn: () => Promise<T>) { return useQuery({ queryKey: key, queryFn: fn }); }
