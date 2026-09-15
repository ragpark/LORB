import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { usePrincipal, useRepository } from '@/app/providers';
import { useInvalidateSpec, useReviews, useSpecification } from '@/features/hooks';
import { Badge, Button, Card, Dialog, EmptyState, Spinner, Table, Tabs, Textarea } from '@/components/nebula';
import { SeverityPill, StagePill, relTime } from '@/components/StagePill';
import { SECTION_DEFINITIONS } from '@/domain/sections';
import type { Finding, FindingCategory, Review } from '@/domain/types';

const CATS: { id: FindingCategory | 'all'; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'warning', label: 'Warnings' }, { id: 'risk', label: 'Risks' }, { id: 'open-question', label: 'Open questions' }, { id: 'suggested-change', label: 'Suggested changes' }];

/** Review Workspace (FR-REV-1..4): findings across all Companion and human review rounds for the current version. */
export function ReviewWorkspacePage() {
  const { id = '' } = useParams();
  const spec = useSpecification(id); const reviews = useReviews(id);
  const [cat, setCat] = useState<FindingCategory | 'all'>('all');
  const [resolving, setResolving] = useState<{ review: Review; finding: Finding; mode: 'resolve' | 'dismiss' } | null>(null);
  if (!spec.data || !reviews.data) return <Spinner />;
  const current = reviews.data.filter((r) => r.version === spec.data!.currentVersion);
  const rows = current.flatMap((r) => r.findings.map((f) => ({ r, f }))).filter(({ f }) => cat === 'all' || f.category === cat);
  const counts = (c: FindingCategory) => current.flatMap((r) => r.findings).filter((f) => f.category === c && f.status === 'open').length;
  const blockers = current.flatMap((r) => r.findings).filter((f) => f.status === 'open' && f.severity === 'blocker').length;
  const reviewers = current.flatMap((r) => r.reviewers ?? []);
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><div className="text-xs text-ink-muted"><Link to={`/specs/${id}`} className="hover:underline">{spec.data.id}</Link> / Review</div><h1 className="text-xl font-semibold">{spec.data.title} <span className="text-ink-muted">v{spec.data.currentVersion}</span></h1></div>
        <div className="flex items-center gap-2"><StagePill stage={spec.data.lifecycleStage} />{blockers > 0 ? <Badge tone="danger">{blockers} blocker(s) open — promotion to Certified blocked</Badge> : <Badge tone="success">No open blockers</Badge>}<Link to={`/specs/${id}`}><Button size="sm">Open editor & AI panel</Button></Link></div>
      </header>
      <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
        <Card>
          <Tabs ariaLabel="Finding categories" value={cat} onChange={setCat} tabs={CATS.map((c) => ({ id: c.id, label: c.id === 'all' ? 'All' : `${c.label} (${counts(c.id)})` }))} />
          <div className="mt-3">
            {rows.length === 0 ? <EmptyState title="No findings" body="Run a review from the AI panel in the editor to generate findings." /> : (
              <Table headers={['Severity', 'Finding', 'Section', 'Round', 'Status', 'Actions']}>
                {rows.map(({ r, f }) => (
                  <tr key={f.id} className={f.status !== 'open' ? 'opacity-60' : ''}>
                    <td className="px-3 py-2"><SeverityPill severity={f.severity} /></td>
                    <td className="px-3 py-2"><div className="font-medium">{f.title}</div><div className="text-xs text-ink-muted">{f.rationale}</div>{f.suggestion && <div className="mt-1 text-xs"><span className="font-semibold">Suggestion:</span> {f.suggestion}</div>}{f.resolution && <div className="mt-1 text-xs text-emerald-800">Resolution: {f.resolution}</div>}</td>
                    <td className="px-3 py-2 text-sm"><Link to={`/specs/${id}?section=${f.sectionKey}`} className="text-brand-700 hover:underline">{SECTION_DEFINITIONS[f.sectionKey]?.label ?? f.sectionKey}</Link></td>
                    <td className="px-3 py-2 text-xs text-ink-muted">{r.kind}<br />{relTime(r.requestedAt)}</td>
                    <td className="px-3 py-2"><Badge tone={f.status === 'open' ? 'warning' : f.status === 'rejected' ? 'neutral' : 'success'}>{f.status}</Badge></td>
                    <td className="px-3 py-2">{f.status === 'open' && <div className="flex gap-1"><Button size="sm" onClick={() => setResolving({ review: r, finding: f, mode: 'resolve' })}>Resolve</Button><Button size="sm" variant="ghost" onClick={() => setResolving({ review: r, finding: f, mode: 'dismiss' })}>Dismiss</Button></div>}</td>
                  </tr>
                ))}
              </Table>
            )}
          </div>
        </Card>
        <Card title="Reviewers">
          {reviewers.length === 0 ? <p className="text-sm text-ink-muted">No human reviewers assigned for this version.</p> : (
            <ul className="space-y-2">{reviewers.map((rv, i) => <li key={i} className="flex items-center justify-between text-sm"><span>{rv.user.displayName}</span><Badge tone={rv.verdict === 'approve' ? 'success' : rv.verdict === 'request-changes' ? 'danger' : 'warning'}>{rv.verdict}</Badge></li>)}</ul>
          )}
          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-ink-muted">Review rounds</h3>
          <ul className="mt-1 space-y-1 text-xs">{current.map((r) => <li key={r.id} className="flex justify-between"><span>{r.kind}</span><span className="text-ink-muted">{r.status} · {r.findings.length} findings</span></li>)}</ul>
        </Card>
      </div>
      {resolving && <ResolveDialog specId={id} {...resolving} onClose={() => setResolving(null)} />}
    </div>
  );
}

function ResolveDialog({ specId, review, finding, mode, onClose }: { specId: string; review: Review; finding: Finding; mode: 'resolve' | 'dismiss'; onClose: () => void }) {
  const repo = useRepository(); const { user } = usePrincipal(); const invalidate = useInvalidateSpec();
  const [text, setText] = useState('');
  const submit = async () => { await repo.updateFinding(specId, review.id, finding.id, { status: mode === 'resolve' ? 'resolved' : 'rejected', resolution: text }, user); await invalidate(specId); onClose(); };
  return (
    <Dialog open title={mode === 'resolve' ? 'Resolve finding' : 'Dismiss finding'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!text.trim()} onClick={submit}>{mode === 'resolve' ? 'Mark resolved' : 'Dismiss'}</Button></>}>
      <p className="mb-2 text-sm font-medium">{finding.title}</p>
      <label className="block text-sm">{mode === 'resolve' ? 'What changed?' : 'Why is this not applicable?'}<Textarea className="mt-1" rows={3} value={text} onChange={(e) => setText(e.target.value)} /></label>
    </Dialog>
  );
}
