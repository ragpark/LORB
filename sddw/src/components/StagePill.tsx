import { Badge } from '@/components/nebula';
import type { LifecycleStage } from '@/domain/types';

const tone: Record<LifecycleStage, 'neutral' | 'warning' | 'success' | 'info' | 'brand'> = { Draft: 'neutral', Review: 'warning', Certified: 'success', 'In Delivery': 'info', Released: 'brand', Retired: 'neutral' };
export function StagePill({ stage }: { stage: LifecycleStage }) { return <Badge tone={tone[stage]}>{stage}</Badge>; }

export function SeverityPill({ severity }: { severity: 'blocker' | 'high' | 'medium' | 'low' }) {
  const t = { blocker: 'danger', high: 'warning', medium: 'info', low: 'neutral' } as const;
  return <Badge tone={t[severity]} className="uppercase">{severity}</Badge>;
}

export function CompletionDot({ completion }: { completion: 'empty' | 'partial' | 'complete' }) {
  const cls = { empty: 'border border-surface-line bg-surface', partial: 'bg-amber-400', complete: 'bg-emerald-500' }[completion];
  return <span aria-label={completion} title={completion} className={`inline-block h-2.5 w-2.5 rounded-full ${cls}`} />;
}

export function relTime(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
