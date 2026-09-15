import { describe, expect, it } from 'vitest';
import { bumpVersion, evaluateTransition, isValidTransition } from '../src/domain/lifecycle';
import type { Approval, Finding } from '../src/domain/types';

const approvals = (status: Approval['status']): Approval[] => (['architecture', 'privacy', 'security', 'product'] as const).map((type) => ({ id: type, specId: 'S', version: '1.0', type, status, evidence: [] }));
const blocker: Finding = { id: 'f1', reviewId: 'r', category: 'warning', severity: 'blocker', sectionKey: 'privacy', title: 'No DPIA', rationale: '', status: 'open' };

describe('lifecycle transitions', () => {
  it('defines the promotion chain and demotions', () => {
    expect(isValidTransition('Draft', 'Review')).toBe('promote');
    expect(isValidTransition('Review', 'Certified')).toBe('promote');
    expect(isValidTransition('Certified', 'In Delivery')).toBe('promote');
    expect(isValidTransition('In Delivery', 'Released')).toBe('promote');
    expect(isValidTransition('Released', 'Retired')).toBe('promote');
    expect(isValidTransition('Review', 'Draft')).toBe('demote');
    expect(isValidTransition('Draft', 'Certified')).toBeNull();
  });
  it('blocks Draft → Review until completion and product intent are ready', () => {
    const base = { spec: { completion: 40, lifecycleStage: 'Draft' as const }, productIntentComplete: false, openBlockers: [], approvals: approvals('pending'), hasDeliveryPack: false, hasReleaseEvidence: false };
    expect(evaluateTransition('Review', base).allowed).toBe(false);
    expect(evaluateTransition('Review', { ...base, spec: { ...base.spec, completion: 65 }, productIntentComplete: true }).allowed).toBe(true);
  });
  it('blocks Review → Certified on open blockers or missing approvals', () => {
    const ctx = { spec: { completion: 95, lifecycleStage: 'Review' as const }, productIntentComplete: true, openBlockers: [blocker], approvals: approvals('approved'), hasDeliveryPack: false, hasReleaseEvidence: false };
    expect(evaluateTransition('Certified', ctx).allowed).toBe(false);
    expect(evaluateTransition('Certified', { ...ctx, openBlockers: [] }).allowed).toBe(true);
    const partial = approvals('approved'); partial[1].status = 'pending';
    expect(evaluateTransition('Certified', { ...ctx, openBlockers: [], approvals: partial }).allowed).toBe(false);
    const waived = approvals('approved'); waived[1].status = 'waived';
    expect(evaluateTransition('Certified', { ...ctx, openBlockers: [], approvals: waived }).allowed).toBe(true);
  });
  it('requires a reason to demote', () => {
    const ctx = { spec: { completion: 70, lifecycleStage: 'Review' as const }, productIntentComplete: true, openBlockers: [], approvals: approvals('pending'), hasDeliveryPack: false, hasReleaseEvidence: false };
    expect(evaluateTransition('Draft', ctx).allowed).toBe(false);
    expect(evaluateTransition('Draft', { ...ctx, reason: 'Scope changed' }).allowed).toBe(true);
  });
  it('bumps versions', () => {
    expect(bumpVersion('1.4', 'save')).toBe('1.5');
    expect(bumpVersion('1.4', 'certify')).toBe('2.0');
  });
});
