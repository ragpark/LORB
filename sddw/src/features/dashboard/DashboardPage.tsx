import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useDashboard, useProductAreas } from '@/features/hooks';
import { Card, EmptyState, Select, Spinner, Stat, Table } from '@/components/nebula';
import { SeverityPill, StagePill, relTime } from '@/components/StagePill';
import { LIFECYCLE_STAGES } from '@/domain/types';

export function DashboardPage() {
  const [area, setArea] = useState('');
  const { data, isLoading } = useDashboard(area || undefined);
  const areas = useProductAreas();
  const nav = useNavigate();
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <label className="flex items-center gap-2 text-sm">Product area
          <Select value={area} onChange={(e) => setArea(e.target.value)} aria-label="Filter by product area"><option value="">All</option>{areas.data?.map((a) => <option key={a}>{a}</option>)}</Select>
        </label>
      </div>
      {isLoading || !data ? <Spinner /> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            {LIFECYCLE_STAGES.map((s) => <Stat key={s} label={s} value={data.byStage[s]} onClick={() => nav(`/specs?stage=${encodeURIComponent(s)}`)} />)}
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card title={`Open blockers (${data.openBlockers.length})`}>
              {data.openBlockers.length === 0 ? <EmptyState title="No open blockers" /> : (
                <ul className="divide-y divide-surface-line">
                  {data.openBlockers.map(({ spec, finding }) => (
                    <li key={finding.id} className="flex items-start gap-3 py-2">
                      <SeverityPill severity={finding.severity} />
                      <div className="min-w-0 flex-1"><Link to={`/specs/${spec.id}/review`} className="font-medium text-brand-700 hover:underline">{spec.id}</Link> <span className="text-ink-muted">· {finding.sectionKey}</span><div className="truncate text-sm">{finding.title}</div></div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title={`Pending reviews (${data.pendingReviews.length})`}>
              {data.pendingReviews.length === 0 ? <EmptyState title="Nothing awaiting review" /> : (
                <ul className="divide-y divide-surface-line">
                  {data.pendingReviews.map(({ spec, review }) => (
                    <li key={review.id} className="flex items-center justify-between py-2">
                      <div><Link to={`/specs/${spec.id}/review`} className="font-medium text-brand-700 hover:underline">{spec.id}</Link> <span className="text-sm">{spec.title}</span><div className="text-xs text-ink-muted">{review.findings.filter((f) => f.status === 'open').length} findings open · {review.reviewers?.filter((r) => r.verdict === 'pending').length ?? 0} reviewer(s) pending</div></div>
                      <StagePill stage={spec.lifecycleStage} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
          <Card title="Certification queue">
            {data.certificationQueue.length === 0 ? <EmptyState title="Certification queue is empty" /> : (
              <Table headers={['Specification', 'Architecture', 'Privacy', 'Security', 'Product', 'Waiting on']}>
                {data.certificationQueue.map(({ spec, approvals }) => {
                  const st = (t: string) => approvals.find((a) => a.type === t)?.status ?? 'pending';
                  const cell = (t: string) => <td key={t} className="px-3 py-2">{st(t) === 'approved' || st(t) === 'waived' ? <span className="text-emerald-700">✓ {st(t)}</span> : st(t) === 'rejected' ? <span className="text-red-700">✕ rejected</span> : <span className="text-ink-subtle">· pending</span>}</td>;
                  return (
                    <tr key={spec.id}>
                      <td className="px-3 py-2"><Link to={`/specs/${spec.id}/certification`} className="font-medium text-brand-700 hover:underline">{spec.id}</Link> <span className="text-ink-muted">{spec.title}</span></td>
                      {['architecture', 'privacy', 'security', 'product'].map(cell)}
                      <td className="px-3 py-2 text-sm">{approvals.filter((a) => a.status === 'pending').map((a) => a.type).join(', ')}</td>
                    </tr>
                  );
                })}
              </Table>
            )}
          </Card>
          <Card title="Recently modified">
            <Table headers={['Spec ID', 'Title', 'Version', 'Stage', 'Modified by', 'When']}>
              {data.recentlyModified.map((s) => (
                <tr key={s.id}>
                  <td className="px-3 py-2"><Link to={`/specs/${s.id}`} className="font-medium text-brand-700 hover:underline">{s.id}</Link></td>
                  <td className="px-3 py-2">{s.title}</td><td className="px-3 py-2 tabular-nums">v{s.currentVersion}</td>
                  <td className="px-3 py-2"><StagePill stage={s.lifecycleStage} /></td><td className="px-3 py-2">{s.updatedBy.displayName}</td>
                  <td className="px-3 py-2 text-ink-muted">{relTime(s.updatedAt)}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}
