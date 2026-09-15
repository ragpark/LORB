import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { usePack, useSpecification } from '@/features/hooks';
import { Badge, Button, Card, EmptyState, Spinner, Table, Tabs } from '@/components/nebula';
import { StagePill, relTime } from '@/components/StagePill';
import type { DeliveryItem, DeliveryItemType, DeliveryPack } from '@/domain/types';

const TYPES: { id: DeliveryItemType; label: string }[] = [
  { id: 'epic', label: 'Epics' }, { id: 'story', label: 'Stories' }, { id: 'acceptance-criterion', label: 'Acceptance criteria' }, { id: 'adr', label: 'ADRs' },
  { id: 'task', label: 'Tasks' }, { id: 'qa-case', label: 'QA matrix' }, { id: 'bdd-scenario', label: 'BDD scenarios' }, { id: 'devops-check', label: 'DevOps checklist' },
];

/** Delivery Pack Generator (FR-DEL-1..3). Generation itself runs from the AI panel; this page displays, traces and exports. */
export function DeliveryPackPage() {
  const { id = '' } = useParams();
  const spec = useSpecification(id); const pack = usePack(id, spec.data?.currentVersion ?? '');
  const [type, setType] = useState<DeliveryItemType>('epic');
  if (!spec.data || pack.isLoading) return <Spinner />;
  const items = pack.data?.items ?? [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const rows = items.filter((i) => i.type === type);
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><div className="text-xs text-ink-muted"><Link to={`/specs/${id}`} className="hover:underline">{spec.data.id}</Link> / Delivery pack</div><h1 className="text-xl font-semibold">{spec.data.title} <span className="text-ink-muted">v{spec.data.currentVersion}</span></h1></div>
        <div className="flex items-center gap-2">
          <StagePill stage={spec.data.lifecycleStage} />
          {pack.data && <Badge tone="neutral">generated {relTime(pack.data.generatedAt)} by {pack.data.generatedBy.displayName}</Badge>}
          {pack.data && <ExportMenu pack={pack.data} />}
          <Button size="sm" variant="secondary" disabled title="Jira / Azure DevOps push is on the roadmap">Push to Jira</Button>
        </div>
      </header>
      {!pack.data ? (
        <EmptyState title="No delivery pack for this version" body={spec.data.lifecycleStage === 'Certified' || spec.data.lifecycleStage === 'In Delivery' ? 'Use “Generate delivery pack” in the AI panel of the editor, then save the result.' : 'A delivery pack can be generated once the specification is Certified.'} action={<Link to={`/specs/${id}`}><Button variant="primary">Open editor</Button></Link>} />
      ) : (
        <Card>
          <Tabs ariaLabel="Delivery item types" value={type} onChange={setType} tabs={TYPES.map((t) => ({ id: t.id, label: `${t.label} (${items.filter((i) => i.type === t.id).length})` }))} />
          <div className="mt-3">
            {rows.length === 0 ? <EmptyState title={`No ${TYPES.find((t) => t.id === type)?.label.toLowerCase()}`} /> : (
              <Table headers={['Key', 'Title', 'Detail', 'Parent', 'Traces to']}>
                {rows.map((i) => (
                  <tr key={i.id}>
                    <td className="px-3 py-2 font-mono text-xs">{i.key}</td>
                    <td className="px-3 py-2 font-medium">{i.title}</td>
                    <td className="px-3 py-2 whitespace-pre-wrap text-sm text-ink-muted">{i.body}</td>
                    <td className="px-3 py-2 text-xs">{i.parentId ? `${byId.get(i.parentId)?.key ?? i.parentId} ${byId.get(i.parentId)?.title ?? ''}` : '—'}</td>
                    <td className="px-3 py-2"><div className="flex flex-wrap gap-1">{i.tracesTo.map((t) => <Link key={t} to={`/specs/${id}?section=${t}`}><Badge tone="brand">{t}</Badge></Link>)}</div></td>
                  </tr>
                ))}
              </Table>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

function ExportMenu({ pack }: { pack: DeliveryPack }) {
  const [open, setOpen] = useState(false);
  const md = useMemo(() => toMarkdown(pack), [pack]);
  const download = (name: string, content: string, type: string) => { const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url); };
  const base = `${pack.specId}-v${pack.version}-delivery-pack`;
  return (
    <div className="relative">
      <Button size="sm" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>Export ▾</Button>
      {open && <ul role="menu" className="absolute right-0 z-10 mt-1 w-40 rounded-nebula border border-surface-line bg-surface p-1 shadow-lg">
        {[['Markdown', () => download(`${base}.md`, md, 'text/markdown')], ['JSON', () => download(`${base}.json`, JSON.stringify(pack, null, 2), 'application/json')], ['CSV', () => download(`${base}.csv`, toCsv(pack.items), 'text/csv')]].map(([label, fn]) => (
          <li key={label as string}><button role="menuitem" className="w-full rounded px-2 py-1 text-left text-sm hover:bg-surface-alt" onClick={() => { (fn as () => void)(); setOpen(false); }}>{label as string}</button></li>
        ))}
      </ul>}
    </div>
  );
}

export function toMarkdown(pack: DeliveryPack): string {
  const out = [`# Delivery pack — ${pack.specId} v${pack.version}`, '', `Generated ${pack.generatedAt} by ${pack.generatedBy.displayName}`, ''];
  for (const t of TYPES) {
    const items = pack.items.filter((i) => i.type === t.id); if (!items.length) continue;
    out.push(`## ${t.label}`, '');
    for (const i of items) out.push(`### ${i.key} ${i.title}`, '', i.body, '', i.parentId ? `Parent: ${i.parentId}  ` : '', i.tracesTo.length ? `Traces to: ${i.tracesTo.join(', ')}` : '', '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
export function toCsv(items: DeliveryItem[]): string {
  const esc = (s: string) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  return ['type,key,title,body,parentId,tracesTo', ...items.map((i) => [i.type, i.key, i.title, i.body, i.parentId ?? '', i.tracesTo.join(';')].map(esc).join(','))].join('\n');
}
