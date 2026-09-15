import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Input, Spinner } from '@/components/nebula';
import { SeverityPill } from '@/components/StagePill';
import { SECTION_DEFINITIONS } from '@/domain/sections';
import type { SectionContentMap, SectionKey, Specification, SpecificationVersion } from '@/domain/types';
import { ACTION_LABELS, SECTION_ACTIONS, SPEC_ACTIONS, type CompanionAction, type CompanionResult } from '@/services/companion/types';
import { useSaveSection } from '@/features/hooks';
import { usePrincipal, useRepository } from '@/app/providers';
import { useCompanionRun } from './useCompanionRun';
import { nowIso, uid } from '@/domain/ids';

/**
 * AI Assistant side panel (FR-AI-1..6). Consumes structured results only; the panel has no prompt text.
 */
export function AssistantPanel({ spec, version, sectionKey, canEdit }: { spec: Specification; version: SpecificationVersion; sectionKey: SectionKey; canEdit: boolean }) {
  const { run, start, cancel, clear } = useCompanionRun(spec.id, version.version);
  const [guidance, setGuidance] = useState('');
  const save = useSaveSection(spec.id);
  const repo = useRepository(); const { user } = usePrincipal();
  const busy = run?.status && (run.status.status === 'queued' || run.status.status === 'running');

  const accept = async (result: CompanionResult) => {
    if (result.kind === 'section-proposal') {
      await save.mutateAsync({ version: version.version, key: result.sectionKey as SectionKey, content: result.proposal as SectionContentMap[SectionKey], etag: version.etag, source: 'ai' });
    } else if (result.kind === 'adrs') {
      const existing = version.sections.adrs.content.adrs;
      await save.mutateAsync({ version: version.version, key: 'adrs', content: { adrs: [...existing, ...result.adrs.filter((a) => !existing.some((e) => e.id === a.id))] }, etag: version.etag, source: 'ai' });
    } else if (result.kind === 'delivery-pack') {
      await repo.savePack({ id: uid('pack'), specId: spec.id, version: version.version, generatedAt: nowIso(), generatedBy: user, reviewId: run?.review.id, items: result.items });
    }
    await repo.appendAudit({ specId: spec.id, version: version.version, action: 'ai.accepted', actor: user, summary: `Accepted ${ACTION_LABELS[run!.action]} proposal (run ${run!.runId})` });
    clear();
  };
  const reject = async () => { await repo.appendAudit({ specId: spec.id, version: version.version, action: 'ai.rejected', actor: user, summary: `Rejected ${ACTION_LABELS[run!.action]} proposal (run ${run!.runId})` }); clear(); };

  return (
    <aside aria-label="AI assistant" className="flex h-full flex-col rounded-nebula border border-surface-line bg-surface">
      <header className="flex items-center justify-between border-b border-surface-line px-4 py-3"><h2 className="text-sm font-semibold">AI Assistant</h2><Badge tone="brand">SDD Companion</Badge></header>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {run && (
          <div className="rounded-nebula border border-brand-100 bg-brand-50/40 p-3" aria-live="polite">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold">{ACTION_LABELS[run.action]}</span>
              <span className="text-ink-muted">run {run.runId.slice(-6)}</span>
            </div>
            {run.error && <p className="mt-2 text-sm text-red-700">{run.error}</p>}
            {busy && <div className="mt-2 flex items-center justify-between"><Spinner label={run.status?.status === 'queued' ? 'Queued' : `Running ${Math.round((run.status?.progress ?? 0) * 100)}%`} /><Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button></div>}
            {run.status?.status === 'complete' && run.status.result && <ResultCard result={run.status.result} specId={spec.id} agentVersion={run.status.agentVersion} onAccept={() => accept(run.status!.result!)} onReject={reject} canEdit={canEdit} action={run.action} saving={save.isPending} />}
            {run.status?.status === 'cancelled' && <p className="mt-2 text-sm text-ink-muted">Cancelled.</p>}
          </div>
        )}
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Section: {SECTION_DEFINITIONS[sectionKey].label}</h3>
          <div className="grid gap-2">{SECTION_ACTIONS.map((a) => <Button key={a} size="sm" disabled={!!busy || !canEdit} onClick={() => start(a, sectionKey, guidance || undefined)}>{ACTION_LABELS[a]}</Button>)}</div>
          <label className="mt-2 block text-xs text-ink-muted">Guidance (optional)<Input className="mt-1 h-8 text-xs" value={guidance} onChange={(e) => setGuidance(e.target.value)} placeholder="e.g. focus on offline learners" /></label>
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Whole specification</h3>
          <div className="grid gap-2">{SPEC_ACTIONS.map((a) => <Button key={a} size="sm" disabled={!!busy || (a === 'generate-delivery-pack' && spec.lifecycleStage !== 'Certified' && spec.lifecycleStage !== 'In Delivery')} title={a === 'generate-delivery-pack' && spec.lifecycleStage !== 'Certified' ? 'Available once the specification is Certified' : undefined} onClick={() => start(a, undefined, guidance || undefined)}>{ACTION_LABELS[a]}</Button>)}</div>
        </div>
      </div>
    </aside>
  );
}

function ResultCard({ result, specId, agentVersion, onAccept, onReject, canEdit, action, saving }: { result: CompanionResult; specId: string; agentVersion: string; onAccept: () => void; onReject: () => void; canEdit: boolean; action: CompanionAction; saving: boolean }) {
  const acceptable = result.kind === 'section-proposal' || result.kind === 'adrs' || result.kind === 'delivery-pack';
  return (
    <div className="mt-3 space-y-2 text-sm">
      <div className="text-xs text-ink-subtle">Agent {agentVersion}</div>
      {result.kind === 'section-proposal' && <>
        <div>Confidence: <Badge tone={result.confidence === 'high' ? 'success' : result.confidence === 'medium' ? 'warning' : 'neutral'}>{result.confidence}</Badge></div>
        <p className="text-ink-muted">{result.rationale}</p>
        <pre className="max-h-48 overflow-auto rounded bg-surface p-2 text-xs">{JSON.stringify(result.proposal, null, 2)}</pre>
      </>}
      {(result.kind === 'findings' || result.kind === 'reuse') && <>
        {result.kind === 'reuse' && <ul className="space-y-1">{result.candidates.map((c) => <li key={c.name} className="rounded border border-surface-line bg-surface p-2"><div className="flex items-center justify-between"><span className="font-medium">{c.name}</span><Badge tone={c.fit === 'high' ? 'success' : c.fit === 'medium' ? 'warning' : 'neutral'}>{c.fit} fit</Badge></div><div className="text-xs text-ink-muted">{c.kind} · {c.owner}</div><p className="text-xs">{c.rationale}</p></li>)}</ul>}
        <ul className="space-y-1">{result.findings.map((f) => <li key={f.id} className="flex gap-2 rounded border border-surface-line bg-surface p-2"><SeverityPill severity={f.severity} /><div><div className="font-medium">{f.title}</div><div className="text-xs text-ink-muted">{f.category} · {f.sectionKey}</div></div></li>)}</ul>
        <p className="text-xs text-ink-muted">{result.findings.length} finding(s) saved to the <Link className="text-brand-700 underline" to={`/specs/${specId}/review`}>Review workspace</Link>.</p>
      </>}
      {result.kind === 'adrs' && <ul className="space-y-1">{result.adrs.map((a) => <li key={a.id} className="rounded border border-surface-line bg-surface p-2"><div className="font-medium">{a.id} {a.title}</div><p className="text-xs text-ink-muted">{a.decision}</p></li>)}</ul>}
      {result.kind === 'delivery-pack' && <p>{result.items.length} items generated ({['epic', 'story', 'acceptance-criterion', 'task'].map((t) => `${result.items.filter((i) => i.type === t).length} ${t}`).join(', ')}…). Accept to save it to the <Link className="text-brand-700 underline" to={`/specs/${specId}/delivery`}>Delivery Pack</Link>.</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button size="sm" onClick={onReject}>{acceptable ? 'Reject' : 'Dismiss'}</Button>
        {acceptable && <Button size="sm" variant="primary" disabled={!canEdit || saving} onClick={onAccept}>{action === 'generate-delivery-pack' ? 'Save pack' : 'Accept'}</Button>}
      </div>
    </div>
  );
}
