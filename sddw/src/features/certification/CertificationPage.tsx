import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { usePrincipal, useRepository } from '@/app/providers';
import { useApprovals, useInvalidateSpec, useReviews, useSpecification } from '@/features/hooks';
import { Badge, Button, Card, Dialog, Field, Input, Select, Spinner, Textarea } from '@/components/nebula';
import { StagePill, relTime } from '@/components/StagePill';
import { canApprove } from '@/domain/authorization';
import { APPROVAL_TYPES, type Approval, type ApprovalType } from '@/domain/types';

const LABEL: Record<ApprovalType, string> = { architecture: 'Architecture', privacy: 'Privacy', security: 'Security', product: 'Product' };

/** Certification Workspace (FR-CERT-1..5). */
export function CertificationPage() {
  const { id = '' } = useParams();
  const spec = useSpecification(id);
  const approvals = useApprovals(id, spec.data?.currentVersion ?? '');
  const principal = usePrincipal();
  const [dlg, setDlg] = useState<{ approval: Approval; mode: 'decide' | 'evidence' } | null>(null);
  if (!spec.data || !approvals.data) return <Spinner />;
  const done = approvals.data.filter((a) => a.status === 'approved' || a.status === 'waived').length;
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><div className="text-xs text-ink-muted"><Link to={`/specs/${id}`} className="hover:underline">{spec.data.id}</Link> / Certification</div><h1 className="text-xl font-semibold">{spec.data.title} <span className="text-ink-muted">v{spec.data.currentVersion}</span></h1></div>
        <div className="flex items-center gap-2"><StagePill stage={spec.data.lifecycleStage} /><Badge tone={done === 4 ? 'success' : 'warning'}>{done}/4 approvals</Badge>{spec.data.certificationStale && <Badge tone="warning">stale — edited since certification</Badge>}</div>
      </header>
      <p className="text-sm text-ink-muted">Certification applies to version {spec.data.currentVersion}. Each approval requires membership of the matching approver group; a specification owner cannot approve their own specification. Waivers need a reason and a second approver.</p>
      <div className="grid gap-4 md:grid-cols-2">
        {APPROVAL_TYPES.map((type) => {
          const a = approvals.data!.find((x) => x.type === type)!;
          const perm = canApprove(principal, spec.data!, type);
          return (
            <Card key={type} title={<span className="flex items-center gap-2">{LABEL[type]} approval <Badge tone={a.status === 'approved' ? 'success' : a.status === 'rejected' ? 'danger' : a.status === 'waived' ? 'info' : 'warning'}>{a.status}</Badge></span>}
              actions={<><Button size="sm" onClick={() => setDlg({ approval: a, mode: 'evidence' })}>+ Evidence</Button><Button size="sm" variant="primary" disabled={!perm.ok} title={perm.reason} onClick={() => setDlg({ approval: a, mode: 'decide' })}>Decide</Button></>}>
              {a.approver ? <p className="text-sm">{a.status} by <strong>{a.approver.displayName}</strong> {a.decidedAt && relTime(a.decidedAt)}{a.comment && <span className="text-ink-muted"> — {a.comment}</span>}{a.waiverReason && <span className="block text-xs text-ink-muted">Waiver: {a.waiverReason} (second approver {a.secondApprover?.displayName})</span>}</p> : <p className="text-sm text-ink-muted">Awaiting decision.</p>}
              {!perm.ok && <p className="mt-1 text-xs text-ink-subtle">{perm.reason}</p>}
              <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">Evidence ({a.evidence.length})</h3>
              {a.evidence.length === 0 ? <p className="text-xs text-ink-subtle">No evidence attached.</p> : (
                <ul className="mt-1 space-y-1 text-sm">{a.evidence.map((e) => <li key={e.id} className="flex items-center justify-between"><span><Badge tone="neutral" className="mr-2">{e.kind}</Badge>{e.uri ? <a href={e.uri} className="text-brand-700 hover:underline" target="_blank" rel="noreferrer">{e.label}</a> : e.reviewId ? <Link to={`/specs/${id}/review`} className="text-brand-700 hover:underline">{e.label}</Link> : e.label}</span><span className="text-xs text-ink-muted">{e.addedBy.displayName} · {relTime(e.addedAt)}</span></li>)}</ul>
              )}
            </Card>
          );
        })}
      </div>
      {dlg?.mode === 'decide' && <DecideDialog specId={id} approval={dlg.approval} onClose={() => setDlg(null)} />}
      {dlg?.mode === 'evidence' && <EvidenceDialog specId={id} approval={dlg.approval} onClose={() => setDlg(null)} />}
    </div>
  );
}

function DecideDialog({ specId, approval, onClose }: { specId: string; approval: Approval; onClose: () => void }) {
  const repo = useRepository(); const { user } = usePrincipal(); const invalidate = useInvalidateSpec();
  const [status, setStatus] = useState<Approval['status']>('approved'); const [comment, setComment] = useState(''); const [waiver, setWaiver] = useState(''); const [second, setSecond] = useState('');
  const submit = async () => {
    await repo.setApproval({ id: specId, version: approval.version, type: approval.type, status, actor: user, comment, waiverReason: status === 'waived' ? waiver : undefined, secondApprover: status === 'waived' ? { id: second, displayName: second, email: second } : undefined });
    await invalidate(specId); onClose();
  };
  return (
    <Dialog open title={`${LABEL[approval.type]} approval — v${approval.version}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={status === 'waived' && (!waiver.trim() || !second.trim())} onClick={submit}>Record decision</Button></>}>
      <div className="space-y-3">
        <Field label="Decision"><Select value={status} onChange={(e) => setStatus(e.target.value as Approval['status'])}><option value="approved">Approve</option><option value="rejected">Reject</option><option value="waived">Waive</option></Select></Field>
        <Field label="Comment"><Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        {status === 'waived' && <><Field label="Waiver reason"><Textarea rows={2} value={waiver} onChange={(e) => setWaiver(e.target.value)} /></Field><Field label="Second approver (email)" hint="Must hold the same approver group and be a different person."><Input value={second} onChange={(e) => setSecond(e.target.value)} /></Field></>}
        <p className="text-xs text-ink-muted">Recorded as {user.displayName} with a timestamp in the audit trail.</p>
      </div>
    </Dialog>
  );
}

function EvidenceDialog({ specId, approval, onClose }: { specId: string; approval: Approval; onClose: () => void }) {
  const repo = useRepository(); const { user } = usePrincipal(); const invalidate = useInvalidateSpec(); const reviews = useReviews(specId);
  const [kind, setKind] = useState<'link' | 'review-run'>('link'); const [label, setLabel] = useState(''); const [uri, setUri] = useState(''); const [reviewId, setReviewId] = useState('');
  const submit = async () => { await repo.addEvidence(specId, approval.id, kind === 'link' ? { kind, label, uri } : { kind, label: label || `Review run ${reviewId.slice(-6)}`, reviewId }, user); await invalidate(specId); onClose(); };
  return (
    <Dialog open title={`Add evidence — ${LABEL[approval.type]}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={kind === 'link' ? !label.trim() || !uri.trim() : !reviewId} onClick={submit}>Attach</Button></>}>
      <div className="space-y-3">
        <Field label="Type"><Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="link">Link (DPIA, threat model, ADR, document)</option><option value="review-run">Companion review run</option></Select></Field>
        {kind === 'link' ? <><Field label="Label"><Input value={label} onChange={(e) => setLabel(e.target.value)} /></Field><Field label="URL"><Input type="url" value={uri} onChange={(e) => setUri(e.target.value)} placeholder="https://" /></Field></>
          : <Field label="Review run"><Select value={reviewId} onChange={(e) => setReviewId(e.target.value)}><option value="">Select…</option>{(reviews.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.kind} · v{r.version} · {relTime(r.requestedAt)} · {r.findings.length} findings</option>)}</Select></Field>}
        <p className="text-xs text-ink-muted">File uploads are stored in the specification's SharePoint folder (evidence/) in the SharePoint and Dataverse configurations.</p>
      </div>
    </Dialog>
  );
}
