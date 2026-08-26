// The audit trail for one entity, shown beside the entity itself: an administrator reading a change
// should not have to go and filter the global audit view to see what it recorded.
import { useQuery } from '@tanstack/react-query';
import { admin } from './lib/catalogue-api.js';

type Row = Record<string, unknown>;

export function AuditTab({ targetType, targetId }: { targetType: string; targetId: string }) {
  const records = useQuery({
    queryKey: ['audit-records', targetType, targetId],
    queryFn: () => admin<{ items: Row[] }>(`audit-records?target_type=${targetType}&target_id=${targetId}`),
  });
  return (
    <ul className="list">
      {(records.data?.items ?? []).map((row) => (
        <li key={String(row.audit_id)}>
          <span className="mono">{String(row.action_type)}</span> — <span className={`outcome outcome-${String(row.outcome).toLowerCase()}`}>{String(row.outcome)}</span> — {String(row.created_at)}
        </li>
      ))}
      {!records.data?.items.length && <li>No audit records yet.</li>}
    </ul>
  );
}
