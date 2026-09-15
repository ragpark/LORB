import type { Approval, Finding, LifecycleStage, Specification } from './types';

export interface GuardContext {
  spec: Pick<Specification, 'completion' | 'lifecycleStage'>;
  productIntentComplete: boolean;
  openBlockers: Finding[];
  approvals: Approval[];
  hasDeliveryPack: boolean;
  hasReleaseEvidence: boolean;
  reason?: string;
}

export interface GuardResult { label: string; ok: boolean; detail?: string }

export interface TransitionEvaluation {
  from: LifecycleStage;
  to: LifecycleStage;
  kind: 'promote' | 'demote';
  allowed: boolean;
  checks: GuardResult[];
}

const PROMOTIONS: Record<LifecycleStage, LifecycleStage | null> = {
  Draft: 'Review',
  Review: 'Certified',
  Certified: 'In Delivery',
  'In Delivery': 'Released',
  Released: 'Retired',
  Retired: null,
};

const DEMOTIONS: Record<LifecycleStage, LifecycleStage | null> = {
  Draft: null,
  Review: 'Draft',
  Certified: 'Draft',
  'In Delivery': null,
  Released: null,
  Retired: null,
};

export function nextStage(from: LifecycleStage): LifecycleStage | null { return PROMOTIONS[from]; }
export function previousStage(from: LifecycleStage): LifecycleStage | null { return DEMOTIONS[from]; }

export function isValidTransition(from: LifecycleStage, to: LifecycleStage): 'promote' | 'demote' | null {
  if (PROMOTIONS[from] === to) return 'promote';
  if (DEMOTIONS[from] === to) return 'demote';
  return null;
}

function certificationChecks(ctx: GuardContext): GuardResult[] {
  const types = ['architecture', 'privacy', 'security', 'product'] as const;
  return types.map((t) => {
    const a = ctx.approvals.find((x) => x.type === t);
    const ok = !!a && (a.status === 'approved' || a.status === 'waived');
    return { label: `${t[0].toUpperCase()}${t.slice(1)} approval`, ok, detail: a ? a.status : 'not started' };
  });
}

/** Evaluate whether a transition is permitted. Pure; used by the UI dialog and by the repository before persisting. */
export function evaluateTransition(to: LifecycleStage, ctx: GuardContext): TransitionEvaluation {
  const from = ctx.spec.lifecycleStage;
  const kind = isValidTransition(from, to);
  if (!kind) {
    return { from, to, kind: 'promote', allowed: false, checks: [{ label: `Transition ${from} → ${to} is not defined`, ok: false }] };
  }
  let checks: GuardResult[] = [];
  if (kind === 'demote') {
    checks = [{ label: 'Reason provided', ok: !!ctx.reason && ctx.reason.trim().length > 0 }];
  } else if (to === 'Review') {
    checks = [
      { label: 'Completion ≥ 60%', ok: ctx.spec.completion >= 60, detail: `${ctx.spec.completion}%` },
      { label: 'Product Intent complete', ok: ctx.productIntentComplete },
    ];
  } else if (to === 'Certified') {
    checks = [
      { label: 'Completion ≥ 90%', ok: ctx.spec.completion >= 90, detail: `${ctx.spec.completion}%` },
      { label: 'No open blocker findings', ok: ctx.openBlockers.length === 0, detail: `${ctx.openBlockers.length} open` },
      ...certificationChecks(ctx),
    ];
  } else if (to === 'In Delivery') {
    checks = [{ label: 'Delivery pack generated for certified version', ok: ctx.hasDeliveryPack }];
  } else if (to === 'Released') {
    checks = [{ label: 'Release evidence linked', ok: ctx.hasReleaseEvidence }];
  } else if (to === 'Retired') {
    checks = [{ label: 'Retirement reason provided', ok: !!ctx.reason && ctx.reason.trim().length > 0 }];
  }
  return { from, to, kind, allowed: checks.every((c) => c.ok), checks };
}

/** Version bump rules: certification bumps major; any other save bumps minor. */
export function bumpVersion(current: string, kind: 'save' | 'certify'): string {
  const [maj = '0', min = '0'] = current.split('.');
  const M = Number(maj), m = Number(min);
  return kind === 'certify' ? `${M + 1}.0` : `${M}.${m + 1}`;
}

export const STAGE_TONE: Record<LifecycleStage, string> = {
  Draft: 'draft', Review: 'review', Certified: 'certified', 'In Delivery': 'delivery', Released: 'released', Retired: 'retired',
};
