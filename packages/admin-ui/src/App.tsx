import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApiRequest, AdminApiError, diagnostics } from './lib/api-client.js';
import { session, signInAdmin, installTabCloseClear } from './lib/auth.js';
import { isSelfApproval } from './lib/separation-of-duties.js';

const ADMIN_API_BASE = import.meta.env.VITE_ADMIN_API_BASE ?? 'http://localhost:3000/api/v1/admin';
const STUB_LOGIN_URL = import.meta.env.VITE_STUB_IES_LOGIN_URL ?? 'http://localhost:4000/dev-login';
const ENVIRONMENT = import.meta.env.VITE_ENVIRONMENT_LABEL ?? 'LOCAL-DEV';

export const DRAFT_BANNER = 'DRAFT — LORB-001 ADMINISTRATION WORKSPACE — NOT PRODUCTION. Synthetic identities only. Not a certified administrative surface.';

type Page = 'signin' | 'overview' | 'repositories' | 'repository-detail' | 'learning-objects' | 'players' | 'player-detail' | 'launch-policies' | 'launch-policy-detail' | 'audit' | 'approvals';
type Row = Record<string, unknown>;

function admin<T>(path: string, options?: Parameters<typeof adminApiRequest>[2]) {
  return adminApiRequest<T>(ADMIN_API_BASE, path, options);
}

function errorMessage(error: unknown): string {
  if (error instanceof AdminApiError) return error.problem.detail || error.problem.title;
  if (error instanceof Error) return error.message;
  return 'The request failed.';
}

function GovernanceNote() {
  return (
    <p className="governance-note">
      This action requires a second, different administrator to approve it before it takes effect (separation of duties). You will not be able to approve your own request.
    </p>
  );
}

function GovernanceStopPanel({ code, approvalRequestId }: { code: string; approvalRequestId?: string }) {
  const isImmutable = code === 'PLAYER_VERSION_IMMUTABLE' || code === 'LAUNCH_POLICY_VERSION_IMMUTABLE';
  return (
    <div className="governance-stop" role="alert">
      <h3>{isImmutable ? 'This version is immutable' : 'A different administrator must approve this'}</h3>
      <p>
        {isImmutable
          ? 'Approved, active, deprecated, suspended and retired versions can never be mutated. Create a new version instead.'
          : 'A principal cannot approve their own approval request. Ask a second administrator to review it from the Approvals inbox.'}
      </p>
      {approvalRequestId && <p>Pending approval reference: <span className="mono">{approvalRequestId}</span></p>}
    </div>
  );
}

function useWhoAmI() {
  return useQuery({ queryKey: ['whoami'], queryFn: () => admin<{ pseudonym: string; role: string; platform_admin: boolean }>('whoami'), enabled: !!session.getToken(), retry: false });
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [subject, setSubject] = useState('synthetic-admin-a');
  const [error, setError] = useState('');
  const identities = ['synthetic-admin-a', 'synthetic-admin-b'];
  const submit = async () => {
    try {
      await signInAdmin(STUB_LOGIN_URL, subject);
      onSignedIn();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <section className="sign-in">
      <h1>Continue with a synthetic administrator identity</h1>
      <p>This is a non-production administration workspace. Synthetic identities only.</p>
      <label>
        Synthetic administrator
        <select value={subject} onChange={(e) => setSubject(e.target.value)}>
          {identities.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert" className="error-text">{error}</p>}
      <button onClick={() => void submit()}>Sign in as administrator</button>
    </section>
  );
}

function Overview({ navigate }: { navigate: (p: Page) => void }) {
  const repos = useQuery({ queryKey: ['repositories'], queryFn: () => admin<{ items: Row[] }>('repositories') });
  const players = useQuery({ queryKey: ['players'], queryFn: () => admin<{ items: Row[] }>('players') });
  const policies = useQuery({ queryKey: ['launch-policies'], queryFn: () => admin<{ items: Row[] }>('launch-policies') });
  const approvals = useQuery({ queryKey: ['approval-requests', 'PENDING'], queryFn: () => admin<{ items: Row[] }>('approval-requests?status=PENDING') });
  const audit = useQuery({ queryKey: ['audit-records'], queryFn: () => admin<{ items: Row[] }>('audit-records?limit=200') });
  const activeRepos = (repos.data?.items ?? []).filter((r) => r.status === 'ACTIVE').length;
  const activePlayers = (players.data?.items ?? []).filter((p) => p.status === 'ACTIVE').length;
  const activePolicies = (policies.data?.items ?? []).filter((p) => p.status === 'ACTIVE').length;
  const pendingApprovals = approvals.data?.items.length ?? 0;
  const dayMs = 24 * 60 * 60 * 1000;
  const recentAudit = (audit.data?.items ?? []).filter((r) => Date.now() - new Date(String(r.created_at)).getTime() < dayMs).length;
  const cards: [string, number, Page][] = [
    ['Active repositories', activeRepos, 'repositories'],
    ['Active players', activePlayers, 'players'],
    ['Active launch policies', activePolicies, 'launch-policies'],
    ['Pending approvals', pendingApprovals, 'approvals'],
    ['Audit records (24h)', recentAudit, 'audit'],
  ];
  return (
    <div>
      <h1>Overview</h1>
      <div className="cards">
        {cards.map(([label, value, target]) => (
          <button key={label} className="card" onClick={() => navigate(target)}>
            <span>{label}</span>
            <strong>{value}</strong>
          </button>
        ))}
      </div>
    </div>
  );
}

function RepositoriesView({ onOpen }: { onOpen: (id: string) => void }) {
  const queryClient = useQueryClient();
  const repos = useQuery({ queryKey: ['repositories'], queryFn: () => admin<{ items: Row[] }>('repositories') });
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const create = async () => {
    setError('');
    try {
      await admin('repositories', { method: 'POST', body: { slug, display_name: displayName } });
      setSlug('');
      setDisplayName('');
      void queryClient.invalidateQueries({ queryKey: ['repositories'] });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <section>
      <h1>Repositories</h1>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label>
          Slug
          <input value={slug} onChange={(e) => setSlug(e.target.value)} pattern="(?:[a-z0-9]|-){3,32}" required />
        </label>
        <label>
          Display name
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} minLength={3} maxLength={120} required />
        </label>
        <button type="submit">Create repository</button>
      </form>
      {error && <p role="alert" className="error-text">{error}</p>}
      <ul className="list">
        {(repos.data?.items ?? []).map((row) => (
          <li key={String(row.repository_id)}>
            <button onClick={() => onOpen(String(row.repository_id))}>
              {String(row.display_name)} <span className="status-badge">{String(row.status)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ApprovalRequiredButton({ label, onRequested, action }: { label: string; onRequested: (approvalRequestId: string) => void; action: () => Promise<{ approval_request_id: string }> }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    try {
      const result = await action();
      setOpen(false);
      onRequested(result.approval_request_id);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      <AlertDialog.Trigger asChild>
        <button className="danger">{label}</button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="overlay" />
        <AlertDialog.Content className="dialog">
          <AlertDialog.Title>{label}</AlertDialog.Title>
          <AlertDialog.Description>This is a governance-material change.</AlertDialog.Description>
          <GovernanceNote />
          {error && <p role="alert" className="error-text">{error}</p>}
          <div className="dialog-actions">
            <AlertDialog.Cancel asChild>
              <button>Cancel</button>
            </AlertDialog.Cancel>
            <button onClick={() => void submit()}>Request {label}</button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function AuditTab({ targetType, targetId }: { targetType: string; targetId: string }) {
  const records = useQuery({ queryKey: ['audit-records', targetType, targetId], queryFn: () => admin<{ items: Row[] }>(`audit-records?target_type=${targetType}&target_id=${targetId}`) });
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

function RepositoryDetail({ repositoryId, onRequested }: { repositoryId: string; onRequested: (id: string) => void }) {
  const repo = useQuery({ queryKey: ['repository', repositoryId], queryFn: () => admin<Row>(`repositories/${repositoryId}`) });
  const memberships = useQuery({ queryKey: ['memberships', repositoryId], queryFn: () => admin<{ items: Row[] }>(`repositories/${repositoryId}/memberships`) });
  const queryClient = useQueryClient();
  const [pseudonym, setPseudonym] = useState('');
  const [role, setRole] = useState('repository_operator');
  const [error, setError] = useState('');
  const grant = async () => {
    setError('');
    try {
      await admin(`repositories/${repositoryId}/memberships`, { method: 'POST', body: { principal_subject_pseudonym: pseudonym, principal_role: role } });
      setPseudonym('');
      void queryClient.invalidateQueries({ queryKey: ['memberships', repositoryId] });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  if (!repo.data) return <p>Loading…</p>;
  return (
    <section>
      <h1>{String(repo.data.display_name)}</h1>
      <p>
        Status: <span className="status-badge">{String(repo.data.status)}</span> · Slug: <span className="mono">{String(repo.data.slug)}</span>
      </p>
      {repo.data.status === 'ACTIVE' && (
        <ApprovalRequiredButton
          label="Suspend repository"
          onRequested={onRequested}
          action={() => admin<{ approval_request_id: string }>(`repositories/${repositoryId}/suspend`, { method: 'POST' })}
        />
      )}
      <Tabs.Root defaultValue="memberships">
        <Tabs.List aria-label="Repository detail">
          <Tabs.Trigger value="memberships">Memberships</Tabs.Trigger>
          <Tabs.Trigger value="audit">Audit</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="memberships">
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void grant();
            }}
          >
            <label>
              Principal pseudonym
              <input value={pseudonym} onChange={(e) => setPseudonym(e.target.value)} required />
            </label>
            <label>
              Role
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="repository_owner">repository_owner</option>
                <option value="repository_operator">repository_operator</option>
                <option value="repository_reader">repository_reader</option>
              </select>
            </label>
            <button type="submit">Grant membership</button>
          </form>
          {error && <p role="alert" className="error-text">{error}</p>}
          <ul className="list">
            {(memberships.data?.items ?? []).map((row) => (
              <li key={String(row.membership_id)}>
                <span className="mono">{String(row.principal_subject_pseudonym)}</span> — {String(row.principal_role)}
              </li>
            ))}
          </ul>
        </Tabs.Content>
        <Tabs.Content value="audit">
          <AuditTab targetType="repository" targetId={repositoryId} />
        </Tabs.Content>
      </Tabs.Root>
    </section>
  );
}

type SmartLink = { smart_link_id: string; object_id: string; token: string; url: string; created_at: string; revoked_at: string | null };

function LearningObjectSmartLink({ objectId }: { objectId: string }) {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const link = useQuery({
    queryKey: ['smart-link', objectId],
    queryFn: async (): Promise<SmartLink | null> => {
      try {
        return await admin<SmartLink>(`learning-objects/${objectId}/smart-link`);
      } catch (e) {
        if (e instanceof AdminApiError && e.problem.code === 'SMART_LINK_NOT_FOUND') return null;
        throw e;
      }
    },
  });
  const copy = async () => {
    setError('');
    setCopied(false);
    try {
      const result = await admin<SmartLink>(`learning-objects/${objectId}/smart-link`, { method: 'POST' });
      await navigator.clipboard.writeText(result.url);
      setCopied(true);
      void queryClient.invalidateQueries({ queryKey: ['smart-link', objectId] });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const revoke = async () => {
    setError('');
    setCopied(false);
    try {
      await admin(`learning-objects/${objectId}/smart-link/revoke`, { method: 'POST' });
      void queryClient.invalidateQueries({ queryKey: ['smart-link', objectId] });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <p className="mono small">
      <button onClick={() => void copy()}>{link.data ? 'Copy smart link' : 'Create smart link'}</button>{' '}
      {link.data && (
        <button onClick={() => void revoke()}>Revoke</button>
      )}
      {link.data && <span> {link.data.url}</span>}
      {copied && <span role="status"> Copied to clipboard.</span>}
      {error && <span role="alert" className="error-text"> {error}</span>}
    </p>
  );
}

function LearningObjectsView() {
  const objects = useQuery({ queryKey: ['learning-objects'], queryFn: () => admin<{ items: Row[] }>('learning-objects') });
  return (
    <section>
      <h1>Learning objects</h1>
      <p className="governance-note">
        Read-only projection of the non-production content catalogue. Content authoring is out of scope for this administration workspace. A smart link lets a
        learner open a published learning object directly in the Player Shell without a consumer or IES login — it is pseudonymous per browser, not tied to a
        real identity, so it must not be used where a real identity is required downstream.
      </p>
      <ul className="list">
        {(objects.data?.items ?? []).map((row) => {
          const pkg = row.package_version as Row | undefined;
          return (
            <li key={String(row.object_id)} className="version-card">
              <p>
                <strong>{String(row.title ?? 'Untitled learning activity')}</strong> <span className="status-badge">{String(row.status)}</span>
              </p>
              <p className="mono small">
                {String(row.kind)} · {String(row.duration ?? 'duration not stated')}
              </p>
              <p>{String(row.description ?? '')}</p>
              {pkg && (
                <p className="mono small">
                  Active package: <span className="mono">{String(pkg.semver)}</span> — <span className="status-badge">{String(pkg.status)}</span>
                </p>
              )}
              {row.status === 'PUBLISHED' && <LearningObjectSmartLink objectId={String(row.object_id)} />}
            </li>
          );
        })}
        {!objects.data?.items.length && <li>No learning objects returned.</li>}
      </ul>
    </section>
  );
}

const ORIGIN_ALLOWLIST_HINT = 'http://localhost:3200 (matches the deployed Player Shell)';

function PlayersView({ onOpen }: { onOpen: (id: string) => void }) {
  const queryClient = useQueryClient();
  const players = useQuery({ queryKey: ['players'], queryFn: () => admin<{ items: Row[] }>('players') });
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const create = async () => {
    setError('');
    try {
      await admin('players', { method: 'POST', body: { display_name: displayName } });
      setDisplayName('');
      void queryClient.invalidateQueries({ queryKey: ['players'] });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <section>
      <h1>Players</h1>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label>
          Display name
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} minLength={3} maxLength={120} required />
        </label>
        <button type="submit">Register player</button>
      </form>
      {error && <p role="alert" className="error-text">{error}</p>}
      <ul className="list">
        {(players.data?.items ?? []).map((row) => (
          <li key={String(row.player_id)}>
            <button onClick={() => onOpen(String(row.player_id))}>
              {String(row.display_name)} <span className="status-badge">{String(row.status)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RegisterVersionForm({ playerId, onRegistered }: { playerId: string; onRegistered: () => void }) {
  const [form, setForm] = useState({ semver: '1.0.0', module_url: '', module_origin: 'http://localhost:3200', integrity_algorithm: 'sha384', integrity_hash: '' });
  const [error, setError] = useState('');
  const submit = async () => {
    setError('');
    try {
      await admin(`players/${playerId}/versions`, {
        method: 'POST',
        body: {
          ...form,
          supported_descriptor_versions: ['1.0'],
          supported_protocol_versions: ['1.0'],
          supported_delivery_profiles: ['native-web-package'],
          supported_launch_modes: ['embedded-iframe'],
        },
      });
      onRegistered();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label>
        Semantic version
        <input value={form.semver} onChange={(e) => setForm({ ...form, semver: e.target.value })} pattern="\d+\.\d+\.\d+" required />
      </label>
      <label>
        Module URL
        <input value={form.module_url} onChange={(e) => setForm({ ...form, module_url: e.target.value })} type="url" required />
      </label>
      <label>
        Module origin (allow-listed origins: {ORIGIN_ALLOWLIST_HINT})
        <input value={form.module_origin} onChange={(e) => setForm({ ...form, module_origin: e.target.value })} type="url" required />
      </label>
      <label>
        Integrity algorithm
        <select value={form.integrity_algorithm} onChange={(e) => setForm({ ...form, integrity_algorithm: e.target.value })}>
          <option value="sha384">sha384</option>
          <option value="sha256">sha256 (rejected — weaker than sha384)</option>
        </select>
      </label>
      <label>
        Integrity hash (hex)
        <input value={form.integrity_hash} onChange={(e) => setForm({ ...form, integrity_hash: e.target.value })} pattern="[0-9a-fA-F]+" required />
      </label>
      <button type="submit">Register version</button>
      {error && <p role="alert" className="error-text">{error}</p>}
    </form>
  );
}

function PlayerDetail({ playerId, onRequested }: { playerId: string; onRequested: (id: string) => void }) {
  const queryClient = useQueryClient();
  const player = useQuery({ queryKey: ['player', playerId], queryFn: () => admin<Row & { versions: Row[] }>(`players/${playerId}`) });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['player', playerId] });
  if (!player.data) return <p>Loading…</p>;
  return (
    <section>
      <h1>{String(player.data.display_name)}</h1>
      <p>
        Status: <span className="status-badge">{String(player.data.status)}</span>
      </p>
      <Tabs.Root defaultValue="versions">
        <Tabs.List aria-label="Player detail">
          <Tabs.Trigger value="versions">Versions</Tabs.Trigger>
          <Tabs.Trigger value="register">Register version</Tabs.Trigger>
          <Tabs.Trigger value="audit">Audit</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="versions">
          <ul className="list">
            {player.data.versions.map((version) => (
              <li key={String(version.player_version_id)} className="version-card">
                <p>
                  <span className="mono">{String(version.semver)}</span> — <span className="status-badge">{String(version.status)}</span>
                </p>
                <p className="mono small">{String(version.module_url)}</p>
                <div className="version-actions">
                  {version.status === 'TESTING' && (
                    <ApprovalRequiredButton
                      label="Approve"
                      onRequested={(id) => {
                        onRequested(id);
                        refresh();
                      }}
                      action={() => admin(`players/${playerId}/versions/${version.player_version_id}/approve`, { method: 'POST' })}
                    />
                  )}
                  {version.status === 'APPROVED' && (
                    <ApprovalRequiredButton
                      label="Activate"
                      onRequested={(id) => {
                        onRequested(id);
                        refresh();
                      }}
                      action={() => admin(`players/${playerId}/versions/${version.player_version_id}/activate`, { method: 'POST' })}
                    />
                  )}
                  {version.status === 'ACTIVE' && (
                    <ApprovalRequiredButton
                      label="Suspend"
                      onRequested={(id) => {
                        onRequested(id);
                        refresh();
                      }}
                      action={() => admin(`players/${playerId}/versions/${version.player_version_id}/suspend`, { method: 'POST' })}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Tabs.Content>
        <Tabs.Content value="register">
          <RegisterVersionForm playerId={playerId} onRegistered={refresh} />
        </Tabs.Content>
        <Tabs.Content value="audit">
          <AuditTab targetType="player_version" targetId={String(player.data.player_id)} />
        </Tabs.Content>
      </Tabs.Root>
    </section>
  );
}

function LaunchPoliciesView({ onOpen }: { onOpen: (id: string) => void }) {
  const queryClient = useQueryClient();
  const policies = useQuery({ queryKey: ['launch-policies'], queryFn: () => admin<{ items: Row[] }>('launch-policies') });
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const create = async () => {
    setError('');
    try {
      await admin('launch-policies', { method: 'POST', body: { display_name: displayName } });
      setDisplayName('');
      void queryClient.invalidateQueries({ queryKey: ['launch-policies'] });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <section>
      <h1>Launch policies</h1>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label>
          Display name
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} minLength={3} maxLength={120} required />
        </label>
        <button type="submit">Create launch policy</button>
      </form>
      {error && <p role="alert" className="error-text">{error}</p>}
      <ul className="list">
        {(policies.data?.items ?? []).map((row) => (
          <li key={String(row.launch_policy_id)}>
            <button onClick={() => onOpen(String(row.launch_policy_id))}>
              {String(row.display_name)} <span className="status-badge">{String(row.status)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AddPolicyVersionForm({ launchPolicyId, onCreated }: { launchPolicyId: string; onCreated: () => void }) {
  const [semver, setSemver] = useState('1.0.0');
  const [repositoryId, setRepositoryId] = useState('');
  const [playerId, setPlayerId] = useState('');
  const [playerVersionId, setPlayerVersionId] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    setError('');
    try {
      const match = repositoryId ? { repository_id: repositoryId } : {};
      await admin(`launch-policies/${launchPolicyId}/versions`, {
        method: 'POST',
        body: { semver, rules: { rules: [{ priority: 0, match, route: { player_id: playerId, player_version_id: playerVersionId } }] } },
      });
      onCreated();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label>
        Semantic version
        <input value={semver} onChange={(e) => setSemver(e.target.value)} pattern="\d+\.\d+\.\d+" required />
      </label>
      <label>
        Match repository ID (leave blank to match any repository)
        <input value={repositoryId} onChange={(e) => setRepositoryId(e.target.value)} />
      </label>
      <label>
        Route to player ID
        <input value={playerId} onChange={(e) => setPlayerId(e.target.value)} required />
      </label>
      <label>
        Route to player version ID
        <input value={playerVersionId} onChange={(e) => setPlayerVersionId(e.target.value)} required />
      </label>
      <button type="submit">Add draft version</button>
      {error && <p role="alert" className="error-text">{error}</p>}
    </form>
  );
}

function LaunchPolicyDetail({ launchPolicyId, onRequested }: { launchPolicyId: string; onRequested: (id: string) => void }) {
  const queryClient = useQueryClient();
  const policy = useQuery({ queryKey: ['launch-policy', launchPolicyId], queryFn: () => admin<Row & { versions: Row[] }>(`launch-policies/${launchPolicyId}`) });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['launch-policy', launchPolicyId] });
  if (!policy.data) return <p>Loading…</p>;
  return (
    <section>
      <h1>{String(policy.data.display_name)}</h1>
      <p>
        Status: <span className="status-badge">{String(policy.data.status)}</span>
      </p>
      <Tabs.Root defaultValue="versions">
        <Tabs.List aria-label="Launch policy detail">
          <Tabs.Trigger value="versions">Versions</Tabs.Trigger>
          <Tabs.Trigger value="add">Add version</Tabs.Trigger>
          <Tabs.Trigger value="audit">Audit</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="versions">
          <ul className="list">
            {policy.data.versions.map((version) => (
              <li key={String(version.launch_policy_version_id)} className="version-card">
                <p>
                  <span className="mono">{String(version.semver)}</span> — <span className="status-badge">{String(version.status)}</span>
                </p>
                <pre className="rules-viewer">{JSON.stringify(version.rules, null, 2)}</pre>
                <div className="version-actions">
                  {version.status === 'DRAFT' && (
                    <ApprovalRequiredButton
                      label="Publish"
                      onRequested={(id) => {
                        onRequested(id);
                        refresh();
                      }}
                      action={() => admin(`launch-policies/${launchPolicyId}/versions/${version.launch_policy_version_id}/publish`, { method: 'POST' })}
                    />
                  )}
                  {version.status === 'PUBLISHED' && (
                    <ApprovalRequiredButton
                      label="Activate"
                      onRequested={(id) => {
                        onRequested(id);
                        refresh();
                      }}
                      action={() => admin(`launch-policies/${launchPolicyId}/versions/${version.launch_policy_version_id}/activate`, { method: 'POST' })}
                    />
                  )}
                  <Tooltip.Provider>
                    <Tooltip.Root>
                      <Tooltip.Trigger asChild>
                        <span>
                          <button disabled>Simulate</button>
                        </span>
                      </Tooltip.Trigger>
                      <Tooltip.Portal>
                        <Tooltip.Content className="tooltip">Deferred to Wave 2</Tooltip.Content>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  </Tooltip.Provider>
                </div>
              </li>
            ))}
          </ul>
        </Tabs.Content>
        <Tabs.Content value="add">
          <AddPolicyVersionForm launchPolicyId={launchPolicyId} onCreated={refresh} />
        </Tabs.Content>
        <Tabs.Content value="audit">
          <AuditTab targetType="launch_policy_version" targetId={String(policy.data.launch_policy_id)} />
        </Tabs.Content>
      </Tabs.Root>
    </section>
  );
}

function AuditView() {
  const [targetType, setTargetType] = useState('');
  const [targetId, setTargetId] = useState('');
  const records = useQuery({
    queryKey: ['audit-records', 'filtered', targetType, targetId],
    queryFn: () => admin<{ items: Row[] }>(`audit-records?${targetType ? `target_type=${targetType}&` : ''}${targetId ? `target_id=${targetId}` : ''}`),
  });
  return (
    <section>
      <h1>Audit</h1>
      <div className="filters">
        <label>
          Target type
          <input value={targetType} onChange={(e) => setTargetType(e.target.value)} placeholder="repository, player_version, …" />
        </label>
        <label>
          Target ID
          <input value={targetId} onChange={(e) => setTargetId(e.target.value)} placeholder="Correlation or target ID" />
        </label>
      </div>
      <ul className="list">
        {(records.data?.items ?? []).map((row) => (
          <li key={String(row.audit_id)}>
            <span className="mono">{String(row.action_type)}</span> on <span className="mono">{String(row.target_type)}</span> —{' '}
            <span className={`outcome outcome-${String(row.outcome).toLowerCase()}`}>{String(row.outcome)}</span> — actor <span className="mono">{String(row.actor_pseudonym)}</span> —{' '}
            {String(row.created_at)}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ApprovalsView() {
  const whoami = useWhoAmI();
  const queryClient = useQueryClient();
  const pending = useQuery({ queryKey: ['approval-requests', 'PENDING'], queryFn: () => admin<{ items: Row[] }>('approval-requests?status=PENDING') });
  // Approved-but-not-yet-executed requests also need to be actionable here — otherwise there is no
  // way to reach the Execute step (Section 15.6.9) once a second administrator has approved one.
  const approved = useQuery({ queryKey: ['approval-requests', 'APPROVED'], queryFn: () => admin<{ items: Row[] }>('approval-requests?status=APPROVED') });
  const approvals = { data: { items: [...(pending.data?.items ?? []), ...(approved.data?.items ?? [])] } };
  const [stop, setStop] = useState<{ code: string; approvalRequestId?: string } | null>(null);
  const respond = async (id: string, action: 'approve' | 'reject') => {
    try {
      await admin(`approval-requests/${id}/${action}`, { method: 'POST' });
      void queryClient.invalidateQueries({ queryKey: ['approval-requests'] });
    } catch (e) {
      if (e instanceof AdminApiError) setStop({ code: e.problem.code, approvalRequestId: id });
    }
  };
  const execute = async (id: string) => {
    try {
      await admin(`approval-requests/${id}/execute`, { method: 'POST' });
      void queryClient.invalidateQueries({ queryKey: ['approval-requests'] });
    } catch (e) {
      if (e instanceof AdminApiError) setStop({ code: e.problem.code, approvalRequestId: id });
    }
  };
  return (
    <section>
      <h1>Approvals inbox</h1>
      {stop && <GovernanceStopPanel code={stop.code} approvalRequestId={stop.approvalRequestId} />}
      <ul className="list">
        {(approvals.data?.items ?? []).map((row) => {
          const requestedBy = String(row.requested_by_pseudonym);
          const self = isSelfApproval(whoami.data?.pseudonym, requestedBy);
          return (
            <li key={String(row.approval_request_id)} className="approval-card">
              <p>
                <span className="mono">{String(row.action_type)}</span> on <span className="mono">{String(row.target_type)}</span>
              </p>
              <p>
                Requested by <span className="mono">{requestedBy}</span>
              </p>
              {row.status === 'PENDING' && (
                <div className="version-actions">
                  <Tooltip.Provider>
                    <Tooltip.Root>
                      <Tooltip.Trigger asChild>
                        <span>
                          <button disabled={self} onClick={() => void respond(String(row.approval_request_id), 'approve')}>
                            Approve
                          </button>
                        </span>
                      </Tooltip.Trigger>
                      {self && (
                        <Tooltip.Portal>
                          <Tooltip.Content className="tooltip">You cannot approve your own request</Tooltip.Content>
                        </Tooltip.Portal>
                      )}
                    </Tooltip.Root>
                  </Tooltip.Provider>
                  <button disabled={self} onClick={() => void respond(String(row.approval_request_id), 'reject')}>
                    Reject
                  </button>
                </div>
              )}
              {row.status === 'APPROVED' && <button onClick={() => void execute(String(row.approval_request_id))}>Execute</button>}
            </li>
          );
        })}
        {!approvals.data?.items.length && <li>No pending approvals.</li>}
      </ul>
    </section>
  );
}

function DiagnosticsDrawer() {
  const [open, setOpen] = useState(false);
  const [, forceRender] = useState(0);
  useEffect(() => {
    const unsubscribe = diagnostics.subscribe(() => forceRender((n) => n + 1));
    return () => {
      unsubscribe();
    };
  }, []);
  const events = diagnostics.snapshot();
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className="diagnostics-trigger">Diagnostics <span>{events.length}</span></button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog drawer">
          <Dialog.Title>Diagnostics</Dialog.Title>
          <Dialog.Description>In-memory log · most recent 100 events · authorisation redacted</Dialog.Description>
          <ul className="list mono small">
            {events.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                {e.at} — {e.direction} — {e.method} {e.url} {e.status ?? ''} {e.errorCode ?? ''}
              </li>
            ))}
          </ul>
          <Dialog.Close asChild>
            <button>Close</button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const nav: [Page, string][] = [
  ['overview', 'Overview'],
  ['repositories', 'Repositories'],
  ['learning-objects', 'Learning objects'],
  ['players', 'Players'],
  ['launch-policies', 'Launch policies'],
  ['approvals', 'Approvals'],
  ['audit', 'Audit'],
];

export function App() {
  const invalidEnvironment = !['LOCAL-DEV', 'RAILWAY-NON-PROD'].includes(ENVIRONMENT);
  const [page, setPage] = useState<Page>(session.getToken() ? 'overview' : 'signin');
  const [selectedId, setSelectedId] = useState<string>('');
  const [lastApprovalRequestId, setLastApprovalRequestId] = useState<string>('');
  const whoami = useWhoAmI();
  useEffect(() => installTabCloseClear(), []);

  if (invalidEnvironment) {
    return (
      <>
        <div className="draft-banner" role="status">{DRAFT_BANNER}</div>
        <main className="fatal">
          <h1>Environment configuration error</h1>
          <p>VITE_ENVIRONMENT_LABEL must be LOCAL-DEV or RAILWAY-NON-PROD.</p>
        </main>
      </>
    );
  }

  const navigateAndOpen = (target: Page, id: string) => {
    setSelectedId(id);
    setPage(target);
  };

  return (
    <div className="app">
      <div className="draft-banner" role="status">{DRAFT_BANNER}</div>
      <a className="skip" href="#main">Skip to content</a>
      <header>
        <div className="brand">
          <span className="mark">L</span>
          <div>
            <strong>LORB Administration</strong>
            <small>DRAFT workspace</small>
          </div>
        </div>
        <span className="env">● {ENVIRONMENT}</span>
        {page !== 'signin' && (
          <div className="operator">
            <span>
              <small>SYNTHETIC ADMINISTRATOR</small>
              {whoami.data?.pseudonym ?? '…'}
            </span>
            <button
              onClick={() => {
                session.clear();
                setPage('signin');
              }}
            >
              Sign out
            </button>
          </div>
        )}
      </header>
      {page === 'signin' ? (
        <SignIn onSignedIn={() => setPage('overview')} />
      ) : (
        <div className="layout">
          <aside>
            <nav aria-label="Main navigation">
              {nav.map(([target, label]) => (
                <button key={target} className={page === target ? 'active' : ''} onClick={() => setPage(target)}>
                  {label}
                </button>
              ))}
            </nav>
            <DiagnosticsDrawer />
          </aside>
          <main id="main">
            {lastApprovalRequestId && page !== 'approvals' && (
              <p className="notice">
                Approval requested: <span className="mono">{lastApprovalRequestId}</span>. Visible in the Approvals inbox and this entity's Audit tab.
              </p>
            )}
            {page === 'overview' && <Overview navigate={setPage} />}
            {page === 'repositories' && <RepositoriesView onOpen={(id) => navigateAndOpen('repository-detail', id)} />}
            {page === 'repository-detail' && <RepositoryDetail repositoryId={selectedId} onRequested={setLastApprovalRequestId} />}
            {page === 'learning-objects' && <LearningObjectsView />}
            {page === 'players' && <PlayersView onOpen={(id) => navigateAndOpen('player-detail', id)} />}
            {page === 'player-detail' && <PlayerDetail playerId={selectedId} onRequested={setLastApprovalRequestId} />}
            {page === 'launch-policies' && <LaunchPoliciesView onOpen={(id) => navigateAndOpen('launch-policy-detail', id)} />}
            {page === 'launch-policy-detail' && <LaunchPolicyDetail launchPolicyId={selectedId} onRequested={setLastApprovalRequestId} />}
            {page === 'audit' && <AuditView />}
            {page === 'approvals' && <ApprovalsView />}
          </main>
        </div>
      )}
    </div>
  );
}
