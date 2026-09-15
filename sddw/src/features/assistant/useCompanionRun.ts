import { useCallback, useEffect, useRef, useState } from 'react';
import { useCompanion, usePrincipal, useRepository } from '@/app/providers';
import { useInvalidateSpec } from '@/features/hooks';
import { nowIso, uid } from '@/domain/ids';
import type { Review, ReviewKind, SectionKey } from '@/domain/types';
import type { CompanionAction, RunStatus } from '@/services/companion/types';

const KIND: Record<CompanionAction, ReviewKind> = { review: 'ai-review', 'critique-section': 'critique', contradictions: 'contradictions', 'constitution-review': 'constitution', 'reuse-review': 'reuse', 'architecture-review': 'architecture', 'privacy-review': 'privacy', 'generate-section': 'generate', 'generate-adrs': 'adrs', 'generate-delivery-pack': 'delivery-pack' };

export interface RunState { runId: string; action: CompanionAction; sectionKey?: SectionKey; status: RunStatus | null; review: Review; error?: string }

/**
 * Starts a Companion run, polls it with back-off, persists the run as a Review (FR-AI-5) and
 * lets the caller decide what to do with the structured result.
 */
export function useCompanionRun(specId: string, version: string) {
  const companion = useCompanion(); const repo = useRepository(); const { user } = usePrincipal(); const invalidate = useInvalidateSpec();
  const [run, setRun] = useState<RunState | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const stop = useCallback(() => { if (timer.current) window.clearTimeout(timer.current); }, []);
  useEffect(() => stop, [stop]);

  const start = useCallback(async (action: CompanionAction, sectionKey?: SectionKey, guidance?: string) => {
    stop();
    const correlationId = uid('corr');
    const review: Review = { id: uid('rev'), specId, version, kind: KIND[action], status: 'queued', requestedBy: user, requestedAt: nowIso(), correlationId, findings: [] };
    await repo.saveReview(review);
    try {
      const accepted = await companion.start({ specId, version, action, sectionKey, guidance, correlationId });
      const state: RunState = { runId: accepted.runId, action, sectionKey, status: null, review };
      setRun(state);
      let delay = 1000;
      const tick = async () => {
        try {
          const status = await companion.poll(accepted.runId);
          const updated: Review = { ...review, status: status.status, agentVersion: status.agentVersion, completedAt: status.status === 'complete' || status.status === 'failed' ? nowIso() : undefined,
            findings: status.result && 'findings' in status.result ? status.result.findings.map((f) => ({ ...f, reviewId: review.id })) : review.findings };
          setRun({ ...state, status, review: updated, error: status.error?.message });
          if (status.status === 'complete' || status.status === 'failed' || status.status === 'cancelled') { await repo.saveReview(updated); await invalidate(specId); return; }
          delay = Math.min(delay * 1.5, 5000);
          timer.current = window.setTimeout(tick, delay);
        } catch (e) { setRun({ ...state, status: null, error: (e as Error).message }); await repo.saveReview({ ...review, status: 'failed', completedAt: nowIso() }); }
      };
      timer.current = window.setTimeout(tick, 600);
    } catch (e) { setRun({ runId: '', action, sectionKey, status: null, review, error: (e as Error).message }); await repo.saveReview({ ...review, status: 'failed', completedAt: nowIso() }); }
  }, [companion, repo, user, specId, version, invalidate, stop]);

  const cancel = useCallback(async () => { if (run?.runId) { await companion.cancel(run.runId); stop(); setRun((r) => (r ? { ...r, status: r.status ? { ...r.status, status: 'cancelled' } : null } : r)); await repo.saveReview({ ...run.review, status: 'cancelled', completedAt: nowIso() }); } }, [companion, run, repo, stop]);
  const clear = useCallback(() => { stop(); setRun(null); }, [stop]);
  return { run, start, cancel, clear };
}
