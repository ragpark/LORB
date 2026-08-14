// STUB — NOT PRODUCTION — BLOCKED BY BLK-03, BLK-11. Administration workspace Wave 1 launch-policy resolution.
export interface LaunchPolicyRule {
  priority: number;
  match?: { consumer_id?: string; repository_id?: string; delivery_profile?: string; launch_mode?: string };
  route: { player_id: string; player_version_id: string };
  effective_at?: string;
  expires_at?: string;
}

export interface LaunchContext {
  consumerId: string;
  repositoryId: string;
  deliveryProfile: string;
  launchMode: string;
}

export interface LaunchPolicyResolution {
  packageUrl: string;
  governedBy: { launchPolicyId: string; launchPolicyVersionId: string; displayName: string; semver: string };
}

function ruleMatches(rule: LaunchPolicyRule, ctx: LaunchContext): boolean {
  const now = Date.now();
  if (rule.effective_at && new Date(rule.effective_at).getTime() > now) return false;
  if (rule.expires_at && new Date(rule.expires_at).getTime() < now) return false;
  const m = rule.match ?? {};
  if (m.consumer_id && m.consumer_id !== ctx.consumerId) return false;
  if (m.repository_id && m.repository_id !== ctx.repositoryId) return false;
  if (m.delivery_profile && m.delivery_profile !== ctx.deliveryProfile) return false;
  if (m.launch_mode && m.launch_mode !== ctx.launchMode) return false;
  return true;
}

type PolicyRow = { launch_policy_id: string; active_launch_policy_version_id: string; display_name: string; rules: { rules: LaunchPolicyRule[] }; semver: string };

/**
 * Consults every active launch policy's active version and picks the highest-priority (lowest
 * number) matching rule across all of them — Wave 1's "single-tenant, single-organisation,
 * single-consumer view" doesn't preclude more than one policy being independently activated, so
 * this can't assume there is exactly one to check. Falls back to no match (default resolver
 * behaviour) when there's no DATABASE_URL, no active policy, or no rule matches anywhere.
 */
export async function resolveLaunchPolicy(ctx: LaunchContext): Promise<LaunchPolicyResolution | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const { adminDbPool } = await import("../db/pool.js");
    const pool = adminDbPool();
    const policies = await pool.query(
      `select lp.launch_policy_id, lp.active_launch_policy_version_id, lp.display_name, lpv.rules, lpv.semver
       from launch_policy lp
       join launch_policy_version lpv on lpv.launch_policy_version_id = lp.active_launch_policy_version_id
       where lp.status = 'ACTIVE' and lp.active_launch_policy_version_id is not null`,
    );
    const candidates = (policies.rows as PolicyRow[]).flatMap((row) => row.rules.rules.filter((rule) => ruleMatches(rule, ctx)).map((rule) => ({ row, rule })));
    if (!candidates.length) return null;
    // Tie-break same-priority rules by specificity (more match keys wins) so a catch-all rule
    // (match: {}) never beats a repository-scoped rule at the same priority — without this, ties
    // fall back to arbitrary SQL row order, which is not a real decision procedure.
    candidates.sort((a, b) => a.rule.priority - b.rule.priority || Object.keys(b.rule.match ?? {}).length - Object.keys(a.rule.match ?? {}).length);
    const best = candidates[0]!;
    const version = await pool.query("select module_url from player_version where player_version_id = $1 and status = 'ACTIVE'", [best.rule.route.player_version_id]);
    const playerVersion = version.rows[0] as { module_url: string } | undefined;
    if (!playerVersion) return null;
    return {
      packageUrl: playerVersion.module_url,
      governedBy: { launchPolicyId: best.row.launch_policy_id, launchPolicyVersionId: best.row.active_launch_policy_version_id, displayName: best.row.display_name, semver: best.row.semver },
    };
  } catch {
    return null;
  }
}
