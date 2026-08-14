-- STUB — NOT PRODUCTION — BLOCKED BY BLK-03, BLK-07, BLK-08, BLK-09, BLK-11. Administration workspace Wave 1 schema.
alter table repository add column if not exists suspended_at timestamptz;
alter table repository add column if not exists retiring_at timestamptz;
alter table repository add column if not exists retired_at timestamptz;

create table repository_membership (membership_id uuid primary key, repository_id uuid not null references repository(repository_id), principal_subject_pseudonym text not null, principal_role text not null check (principal_role in ('repository_owner','repository_operator','repository_reader')), granted_by_pseudonym text not null, granted_at timestamptz not null default now(), revoked_at timestamptz, revoked_by_pseudonym text, correlation_id text not null, unique (repository_id, principal_subject_pseudonym, principal_role, revoked_at));
create index repository_membership_repo_idx on repository_membership(repository_id);
create index repository_membership_principal_idx on repository_membership(principal_subject_pseudonym);

create table player (player_id uuid primary key, display_name text not null, owner_pseudonym text not null, status text not null check (status in ('REGISTERED','TESTING','APPROVED','ACTIVE','DEPRECATED','SUSPENDED','RETIRED')), active_player_version_id uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now());

create table player_version (player_version_id uuid primary key, player_id uuid not null references player(player_id), semver text not null, module_url text not null, module_origin text not null, integrity_algorithm text not null check (integrity_algorithm in ('sha384','sha256')), integrity_hash text not null, supported_descriptor_versions text[] not null, supported_protocol_versions text[] not null, supported_delivery_profiles text[] not null check (supported_delivery_profiles <@ array['native-web-package']::text[]), supported_launch_modes text[] not null check (supported_launch_modes <@ array['embedded-iframe']::text[]), status text not null check (status in ('REGISTERED','TESTING','APPROVED','ACTIVE','DEPRECATED','SUSPENDED','RETIRED')), registered_at timestamptz not null default now(), approved_at timestamptz, approved_by_pseudonym text, activated_at timestamptz, activated_by_pseudonym text, suspended_at timestamptz, suspended_by_pseudonym text, correlation_id text not null, unique (player_id, semver));
create index player_version_player_idx on player_version(player_id);

create table launch_policy (launch_policy_id uuid primary key, display_name text not null, owner_pseudonym text not null, active_launch_policy_version_id uuid, status text not null check (status in ('DRAFT','ACTIVE','SUSPENDED','RETIRED')), created_at timestamptz not null default now(), updated_at timestamptz not null default now());

create table launch_policy_version (launch_policy_version_id uuid primary key, launch_policy_id uuid not null references launch_policy(launch_policy_id), semver text not null, rules jsonb not null, status text not null check (status in ('DRAFT','PUBLISHED','SUPERSEDED','RETIRED')), published_at timestamptz, published_by_pseudonym text, correlation_id text not null, unique (launch_policy_id, semver));
create index launch_policy_version_policy_idx on launch_policy_version(launch_policy_id);

create table approval_request (approval_request_id uuid primary key, action_type text not null, target_type text not null, target_id uuid not null, requested_by_pseudonym text not null, requested_at timestamptz not null default now(), approver_pseudonym text, approved_at timestamptz, status text not null check (status in ('PENDING','APPROVED','REJECTED','EXECUTED','CANCELLED')), rejection_reason text, correlation_id text not null, detail jsonb, check (approver_pseudonym is null or approver_pseudonym <> requested_by_pseudonym));
create index approval_request_status_idx on approval_request(status);
create index approval_request_target_idx on approval_request(target_type, target_id);

create table audit_record (audit_id uuid primary key, actor_pseudonym text not null, actor_role text not null, action_type text not null, target_type text not null, target_id uuid, prior_state jsonb, resulting_state jsonb, outcome text not null check (outcome in ('ALLOWED','DENIED','FAILED')), reason text, approval_request_id uuid references approval_request(approval_request_id), correlation_id text not null, created_at timestamptz not null default now());
create index audit_record_actor_idx on audit_record(actor_pseudonym);
create index audit_record_target_idx on audit_record(target_type, target_id);
create index audit_record_created_idx on audit_record(created_at);

-- Immutability: player_version metadata is frozen once it leaves REGISTERED/TESTING.
create or replace function admin_enforce_player_version_immutability() returns trigger as $$
begin
  if old.status in ('APPROVED','ACTIVE','DEPRECATED','SUSPENDED','RETIRED') then
    if new.module_url is distinct from old.module_url
      or new.module_origin is distinct from old.module_origin
      or new.integrity_algorithm is distinct from old.integrity_algorithm
      or new.integrity_hash is distinct from old.integrity_hash
      or new.semver is distinct from old.semver
      or new.supported_descriptor_versions is distinct from old.supported_descriptor_versions
      or new.supported_protocol_versions is distinct from old.supported_protocol_versions
      or new.supported_delivery_profiles is distinct from old.supported_delivery_profiles
      or new.supported_launch_modes is distinct from old.supported_launch_modes
    then
      raise exception 'PLAYER_VERSION_IMMUTABLE';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;
create trigger player_version_immutability before update on player_version for each row execute function admin_enforce_player_version_immutability();

-- Immutability: launch_policy_version rules/semver are frozen once published.
create or replace function admin_enforce_launch_policy_version_immutability() returns trigger as $$
begin
  if old.status in ('PUBLISHED','SUPERSEDED','RETIRED') then
    if new.rules is distinct from old.rules or new.semver is distinct from old.semver then
      raise exception 'LAUNCH_POLICY_VERSION_IMMUTABLE';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;
create trigger launch_policy_version_immutability before update on launch_policy_version for each row execute function admin_enforce_launch_policy_version_immutability();

-- Audit records are append-only.
create or replace function admin_audit_record_append_only() returns trigger as $$
begin
  raise exception 'AUDIT_RECORD_IMMUTABLE';
end;
$$ language plpgsql;
create trigger audit_record_no_update before update on audit_record for each row execute function admin_audit_record_append_only();
create trigger audit_record_no_delete before delete on audit_record for each row execute function admin_audit_record_append_only();
