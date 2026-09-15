import { Link } from 'react-router-dom';
import { useDashboard } from '@/features/hooks';
import { Card, EmptyState, Spinner, Table } from '@/components/nebula';
import { SeverityPill, StagePill } from '@/components/StagePill';

/** Top-level "Reviews" view: everything with open findings, across the portfolio. */
export function ReviewsQueuePage() {
  const { data } = useDashboard();
  if (!data) return <Spinner />;
  const rows = [...data.pendingReviews];
  return <div className="space-y-4"><h1 className="text-xl font-semibold">Review queue</h1>
    <Card>{rows.length === 0 && data.openBlockers.length === 0 ? <EmptyState title="Nothing awaiting review" /> : (
      <Table headers={['Specification', 'Stage', 'Open findings', 'Blockers', 'Reviewers pending']}>
        {rows.map(({ spec, review }) => <tr key={review.id}><td className="px-3 py-2"><Link to={`/specs/${spec.id}/review`} className="font-medium text-brand-700 hover:underline">{spec.id}</Link> {spec.title}</td><td className="px-3 py-2"><StagePill stage={spec.lifecycleStage} /></td><td className="px-3 py-2">{review.findings.filter((f) => f.status === 'open').length}</td><td className="px-3 py-2">{review.findings.filter((f) => f.status === 'open' && f.severity === 'blocker').length}</td><td className="px-3 py-2">{review.reviewers?.filter((r) => r.verdict === 'pending').map((r) => r.user.displayName).join(', ') || '—'}</td></tr>)}
        {data.openBlockers.filter((b) => !rows.some((r) => r.spec.id === b.spec.id)).map(({ spec, finding }) => <tr key={finding.id}><td className="px-3 py-2"><Link to={`/specs/${spec.id}/review`} className="font-medium text-brand-700 hover:underline">{spec.id}</Link> {spec.title}</td><td className="px-3 py-2"><StagePill stage={spec.lifecycleStage} /></td><td className="px-3 py-2">—</td><td className="px-3 py-2"><SeverityPill severity={finding.severity} /> {finding.title}</td><td className="px-3 py-2">—</td></tr>)}
      </Table>)}
    </Card></div>;
}

/** Top-level "Certification" view: certification queue across the portfolio. */
export function CertificationQueuePage() {
  const { data } = useDashboard();
  if (!data) return <Spinner />;
  return <div className="space-y-4"><h1 className="text-xl font-semibold">Certification queue</h1>
    <Card>{data.certificationQueue.length === 0 ? <EmptyState title="No specifications awaiting certification" /> : (
      <Table headers={['Specification', 'Stage', 'Approved', 'Waiting on']}>
        {data.certificationQueue.map(({ spec, approvals }) => <tr key={spec.id}><td className="px-3 py-2"><Link to={`/specs/${spec.id}/certification`} className="font-medium text-brand-700 hover:underline">{spec.id}</Link> {spec.title}</td><td className="px-3 py-2"><StagePill stage={spec.lifecycleStage} /></td><td className="px-3 py-2">{approvals.filter((a) => a.status === 'approved' || a.status === 'waived').length}/4</td><td className="px-3 py-2">{approvals.filter((a) => a.status === 'pending').map((a) => a.type).join(', ')}</td></tr>)}
      </Table>)}
    </Card></div>;
}

/** Top-level "Delivery" view: certified and in-delivery specifications. */
export function DeliveryQueuePage() {
  const { data } = useDashboard();
  if (!data) return <Spinner />;
  const rows = data.recentlyModified.filter((s) => s.lifecycleStage === 'Certified' || s.lifecycleStage === 'In Delivery');
  return <div className="space-y-4"><h1 className="text-xl font-semibold">Delivery</h1>
    <Card>{rows.length === 0 ? <EmptyState title="No certified specifications" body="Delivery packs are generated from Certified versions." /> : (
      <Table headers={['Specification', 'Stage', 'Version', 'Delivery pack']}>
        {rows.map((s) => <tr key={s.id}><td className="px-3 py-2"><Link to={`/specs/${s.id}/delivery`} className="font-medium text-brand-700 hover:underline">{s.id}</Link> {s.title}</td><td className="px-3 py-2"><StagePill stage={s.lifecycleStage} /></td><td className="px-3 py-2">v{s.currentVersion}</td><td className="px-3 py-2"><Link to={`/specs/${s.id}/delivery`} className="text-brand-700 hover:underline">Open</Link></td></tr>)}
      </Table>)}
    </Card></div>;
}
