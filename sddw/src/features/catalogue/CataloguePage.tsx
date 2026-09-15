import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useCatalogue, useCreateSpecification, useProductAreas, useTags } from '@/features/hooks';
import { Button, Card, Dialog, EmptyState, Field, Input, ProgressBar, Select, Spinner, Table } from '@/components/nebula';
import { StagePill, relTime } from '@/components/StagePill';
import { LIFECYCLE_STAGES, type CatalogueQuery, type LifecycleStage, type SpecificationSummary } from '@/domain/types';

export function CataloguePage() {
  const [params, setParams] = useSearchParams();
  const areas = useProductAreas(); const tags = useTags();
  const [sort, setSort] = useState<CatalogueQuery['sort']>({ field: 'updatedAt', dir: 'desc' });
  const page = Number(params.get('page') ?? 1);
  const q: CatalogueQuery = useMemo(() => ({
    search: params.get('q') ?? undefined,
    productArea: params.getAll('area').filter(Boolean),
    lifecycleStage: params.getAll('stage').filter(Boolean) as LifecycleStage[],
    status: params.getAll('status').filter(Boolean) as CatalogueQuery['status'],
    tag: params.getAll('tag').filter(Boolean),
    owner: params.getAll('owner').filter(Boolean),
    sort, page, pageSize: 25,
  }), [params, sort, page]);
  const { data, isLoading } = useCatalogue(q);
  const [creating, setCreating] = useState(false);
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); p.delete(k); if (v) p.set(k, v); p.delete('page'); setParams(p); };
  const owners = useMemo(() => { const m = new Map<string, string>(); data?.items.forEach((i) => m.set(i.owner.id, i.owner.displayName)); return [...m.entries()]; }, [data]);
  const th = (label: string, field: keyof SpecificationSummary) => (
    <button className="inline-flex items-center gap-1" onClick={() => setSort((s) => ({ field, dir: s?.field === field && s.dir === 'asc' ? 'desc' : 'asc' }))} aria-sort={sort?.field === field ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      {label}{sort?.field === field && <span aria-hidden>{sort.dir === 'asc' ? '↑' : '↓'}</span>}
    </button>
  );
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-xl font-semibold">Specification Catalogue</h1><Button variant="primary" onClick={() => setCreating(true)}>+ New specification</Button></div>
      <Card>
        <div className="grid gap-3 md:grid-cols-6">
          <Field label="Search"><Input value={params.get('q') ?? ''} onChange={(e) => set('q', e.target.value)} placeholder="Title or Spec ID" /></Field>
          <Field label="Product area"><Select value={params.get('area') ?? ''} onChange={(e) => set('area', e.target.value)}><option value="">All</option>{areas.data?.map((a) => <option key={a}>{a}</option>)}</Select></Field>
          <Field label="Owner"><Select value={params.get('owner') ?? ''} onChange={(e) => set('owner', e.target.value)}><option value="">All</option>{owners.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</Select></Field>
          <Field label="Status"><Select value={params.get('status') ?? ''} onChange={(e) => set('status', e.target.value)}><option value="">All</option>{['Active', 'On hold', 'Archived'].map((s) => <option key={s}>{s}</option>)}</Select></Field>
          <Field label="Lifecycle stage"><Select value={params.get('stage') ?? ''} onChange={(e) => set('stage', e.target.value)}><option value="">All</option>{LIFECYCLE_STAGES.map((s) => <option key={s}>{s}</option>)}</Select></Field>
          <Field label="Tag"><Select value={params.get('tag') ?? ''} onChange={(e) => set('tag', e.target.value)}><option value="">All</option>{tags.data?.map((t) => <option key={t}>{t}</option>)}</Select></Field>
        </div>
        {[...params.keys()].length > 0 && <div className="mt-3"><Button size="sm" variant="ghost" onClick={() => setParams(new URLSearchParams())}>Clear filters</Button></div>}
      </Card>
      <Card>
        {isLoading || !data ? <Spinner /> : data.items.length === 0 ? <EmptyState title="No specifications match" body="Adjust the filters or create a new specification." action={<Button variant="primary" onClick={() => setCreating(true)}>New specification</Button>} /> : (
          <>
            <Table headers={[th('Spec ID', 'id'), th('Title', 'title'), th('Area', 'productArea'), th('Owner', 'owner'), th('Stage', 'lifecycleStage'), th('Version', 'currentVersion'), th('Completion', 'completion'), th('Updated', 'updatedAt')]} caption="Specifications">
              {data.items.map((s) => (
                <tr key={s.id} className="hover:bg-surface-alt">
                  <td className="px-3 py-2"><Link to={`/specs/${s.id}`} className="font-medium text-brand-700 hover:underline">{s.id}</Link></td>
                  <td className="px-3 py-2">{s.title}<div className="text-xs text-ink-subtle">{s.tags.join(' · ')}</div></td>
                  <td className="px-3 py-2">{s.productArea}</td><td className="px-3 py-2">{s.owner.displayName}</td>
                  <td className="px-3 py-2"><StagePill stage={s.lifecycleStage} /></td><td className="px-3 py-2 tabular-nums">v{s.currentVersion}</td>
                  <td className="px-3 py-2"><ProgressBar value={s.completion} /></td><td className="px-3 py-2 text-ink-muted">{relTime(s.updatedAt)}</td>
                </tr>
              ))}
            </Table>
            <div className="mt-3 flex items-center justify-between text-sm text-ink-muted">
              <span>{data.total} specification(s)</span>
              <div className="flex gap-2"><Button size="sm" disabled={page <= 1} onClick={() => set('page', String(page - 1))}>Previous</Button><Button size="sm" disabled={page * data.pageSize >= data.total} onClick={() => set('page', String(page + 1))}>Next</Button></div>
            </div>
          </>
        )}
      </Card>
      <NewSpecificationDialog open={creating} onClose={() => setCreating(false)} areas={areas.data ?? []} />
    </div>
  );
}

function NewSpecificationDialog({ open, onClose, areas }: { open: boolean; onClose: () => void; areas: string[] }) {
  const [title, setTitle] = useState(''); const [area, setArea] = useState(''); const [tags, setTags] = useState('');
  const create = useCreateSpecification(); const nav = useNavigate();
  const submit = async () => { const spec = await create.mutateAsync({ title, productArea: area || areas[0] || 'General', tags: tags.split(',').map((t) => t.trim()).filter(Boolean) }); onClose(); nav(`/specs/${spec.id}`); };
  return (
    <Dialog open={open} onClose={onClose} title="New specification" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!title.trim() || create.isPending} onClick={submit}>Create</Button></>}>
      <div className="space-y-3">
        <Field label="Title" id="ns-title"><Input id="ns-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></Field>
        <Field label="Product area" id="ns-area" hint="Drives the Spec ID prefix, e.g. SPEC-LRN-0043"><Input id="ns-area" list="areas" value={area} onChange={(e) => setArea(e.target.value)} placeholder={areas[0] ?? 'Learning'} /><datalist id="areas">{areas.map((a) => <option key={a} value={a} />)}</datalist></Field>
        <Field label="Tags" id="ns-tags" hint="Comma separated"><Input id="ns-tags" value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
        <p className="text-xs text-ink-muted">You will be recorded as the owner. Specifications start in Draft at version 0.1.</p>
      </div>
    </Dialog>
  );
}
