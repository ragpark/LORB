import type { Approval, ApprovalType, Specification, UserRef } from './types';

export type Role = 'reader' | 'contributor' | 'reviewer' | 'approver' | 'admin';

/** Entra group names that grant approver roles. Mirror in storage-side security. */
export const APPROVER_GROUPS: Record<ApprovalType, string> = {
  architecture: 'sddw-approvers-architecture',
  privacy: 'sddw-approvers-privacy',
  security: 'sddw-approvers-security',
  product: 'sddw-approvers-product',
};
export const ADMIN_GROUP = 'sddw-admins';

export interface Principal { user: UserRef; groups: string[] }

export const isAdmin = (p: Principal) => p.groups.includes(ADMIN_GROUP);

export function canEdit(p: Principal, spec: Specification): boolean {
  if (isAdmin(p)) return true;
  if (spec.lifecycleStage === 'Retired') return false;
  return spec.owner.id === p.user.id || spec.contributors.some((c) => c.id === p.user.id);
}

export function approvalTypesFor(p: Principal): ApprovalType[] {
  return (Object.keys(APPROVER_GROUPS) as ApprovalType[]).filter((t) => p.groups.includes(APPROVER_GROUPS[t]));
}

/** Approver must hold the group for the type and must not own the specification. */
export function canApprove(p: Principal, spec: Specification, type: ApprovalType): { ok: boolean; reason?: string } {
  if (spec.owner.id === p.user.id) return { ok: false, reason: 'A specification owner cannot approve their own specification.' };
  if (!p.groups.includes(APPROVER_GROUPS[type]) && !isAdmin(p)) return { ok: false, reason: `Requires membership of ${APPROVER_GROUPS[type]}.` };
  return { ok: true };
}

/** A waiver needs a second approver distinct from the first, holding the same group. */
export function canWaive(p: Principal, spec: Specification, approval: Approval, second: Principal): { ok: boolean; reason?: string } {
  const first = canApprove(p, spec, approval.type);
  if (!first.ok) return first;
  if (second.user.id === p.user.id) return { ok: false, reason: 'Second approver must be a different person.' };
  const sec = canApprove(second, spec, approval.type);
  if (!sec.ok) return { ok: false, reason: `Second approver: ${sec.reason}` };
  return { ok: true };
}

export function canPromote(p: Principal, spec: Specification): boolean {
  return canEdit(p, spec) || isAdmin(p);
}
