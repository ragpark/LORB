import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminApiError, diagnostics } from './lib/api-client.js';
import { admin, errorMessage } from './lib/catalogue-api.js';
import { AuditTab } from './audit.js';
import { LearningObjectDetail, LearningObjectsView } from './learning-objects.js';
import { session, signInForDevelopment, adminOidcClient, adoptProviderSession, installTabCloseClear } from './lib/auth.js';
import { allowsDevelopmentSignIn, ENVIRONMENT_LABELS, environmentNotice, isEnvironmentLabel, session as providerSession } from '@lorb/web-auth';
import { isSelfApproval } from './lib/separation-of-duties.js';
import { webEnv } from './runtime-env.js';

const DEVELOPMENT_LOGIN_URL = webEnv.VITE_DEVELOPMENT_LOGIN_URL ?? webEnv.VITE_DEVELOPMENT_IDENTITY_LOGIN_URL ?? 'http://localhost:4000/dev-login';
const ENVIRONMENT = webEnv.VITE_ENVIRONMENT_LABEL ?? 'DEVELOPMENT';

/**
 * The notice a non-production workspace carries. Production shows none: an administrator needs to
 * know when the records in front of them are *not* real, and a banner that is always there stops
 * being read long before the one time it matters.
 */
export const ENVIRONMENT_NOTICE = isEnvironmentLabel(ENVIRONMENT) ? environmentNotice(ENVIRONMENT) : undefined;

type Page = 'signin' | 'overview' | 'repositories' | 'repository-detail' | 'learning-objects' | 'learning-object-detail' | 'players' | 'player-detail' | 'launch-policies' | 'launch-policy-detail' | 'audit' | 'approvals';
type Row = Record<string, unknown>;

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
  const [subject, setSubject] = useState('administrator-a');
  const [error, setError] = useState('');
  const oidc = useMemo(() => adminOidcClient(), []);

  // A configured provider is the only way in wherever one exists. The local identities below are
  // reachable only in a development build that has no provider at all.
  const identities = ['administrator-a', 'administrator-b'];
  const submitDevelopment = async () => {
    try {
      await signInForDevelopment(DEVELOPMENT_LOGIN_URL, subject, ENVIRONMENT);
      onSignedIn();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  if (oidc) {
    return (
      <section className="sign-in">
        <h1>Sign in to the Administration workspace</h1>
        <p>You will be taken to your organisation&rsquo;s identity provider.</p>
        {error && <p role="alert" className="error-text">{error}</p>}
        <button onClick={() => void oidc.signIn().catch((e) => setError(errorMessage(e)))}>Continue to sign in</button>
      </section>
    );
  }

  return (
    <section className="sign-in">
      <h1>Sign in to the Administration workspace</h1>
      <p>No identity provider is configured for this environment, so a local administrator is used.</p>
      <label>
        Administrator
        <select value={subject} onChange={(e) => setSubject(e.target.value)}>
          {identities.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert" className="error-text">{error}</p>}
      <button onClick={() => void submitDevelopment()}>Sign in as administrator</button>
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
  const invalidEnvironment = !ENVIRONMENT_LABELS.includes(ENVIRONMENT as never);
  const [page, setPage] = useState<Page>(session.getToken() ? 'overview' : 'signin');
  const [selectedId, setSelectedId] = useState<string>('');
  const [lastApprovalRequestId, setLastApprovalRequestId] = useState<string>('');
  const whoami = useWhoAmI();
  const [signInError, setSignInError] = useState('');
  useEffect(() => installTabCloseClear(), []);

  // A deep link from the Operations Console: that console reads the catalogue and does not edit it,
  // so an operator who finds something wrong there arrives here already pointed at the record.
  useEffect(() => {
    const match = /^#learning-object\/([0-9a-fA-F-]{36})$/.exec(window.location.hash);
    if (!match || !session.getToken()) return;
    setSelectedId(match[1]!);
    setPage('learning-object-detail');
  }, []);

  // Completes a provider redirect if this load is one. Called unconditionally: the client reports
  // false when the URL is not a callback, so there is nothing to branch on before asking.
  useEffect(() => {
    const oidc = adminOidcClient();
    if (!oidc) return;
    void oidc.completeSignIn()
      .then((completed) => {
        const token = providerSession.token;
        if (completed && token) {
          adoptProviderSession(token);
          setPage('overview');
        }
      })
      .catch((e) => setSignInError(errorMessage(e)));
  }, []);

  if (invalidEnvironment) {
    return (
      <main className="fatal">
        <h1>Environment configuration error</h1>
        <p>VITE_ENVIRONMENT_LABEL must be one of {ENVIRONMENT_LABELS.join(', ')}.</p>
      </main>
    );
  }

  // Outside development the identity provider is the only way in, so a build without one is a
  // misconfiguration to refuse loudly — not a workspace that renders and then fails every request.
  if (!allowsDevelopmentSignIn(ENVIRONMENT as never) && !adminOidcClient()) {
    return (
      <main className="fatal">
        <h1>Environment configuration error</h1>
        <p>This environment requires an identity provider: set VITE_OIDC_ISSUER and VITE_OIDC_CLIENT_ID.</p>
      </main>
    );
  }

  const navigateAndOpen = (target: Page, id: string) => {
    setSelectedId(id);
    setPage(target);
  };

  return (
    <div className="app">
      {ENVIRONMENT_NOTICE && <div className="environment-notice" role="status">{ENVIRONMENT_NOTICE}</div>}
      {signInError && <div className="error-text" role="alert">{signInError}</div>}
      <a className="skip" href="#main">Skip to content</a>
      <header>
        <div className="brand">
          <span className="mark">L</span>
          <div>
            <strong>LORB Administration</strong>
            <small>Administration workspace</small>
          </div>
        </div>
        <span className="env">● {ENVIRONMENT}</span>
        {page !== 'signin' && (
          <div className="operator">
            <span>
              <small>ADMINISTRATOR</small>
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
            {page === 'learning-objects' && <LearningObjectsView onOpen={(id) => navigateAndOpen('learning-object-detail', id)} />}
            {page === 'learning-object-detail' && <LearningObjectDetail objectId={selectedId} onClosed={() => setPage('learning-objects')} />}
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
