-- Production runtime schema.
--
-- Until now the Runtime API kept attempts, launches, idempotency records, the evidence outbox and
-- the learning-object catalogue in process memory. That made the service unable to survive a
-- restart, unable to run more than one replica without sticky routing, and unable to guarantee that
-- an accepted piece of evidence would ever be delivered. This migration makes Postgres the system of
-- record for all of it.
--
-- Two shapes carry over from the roster design deliberately: nothing here stores a learner's
-- platform identifier next to their pseudonym, and evidence rows are append-only apart from their
-- own delivery bookkeeping.

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------

alter table learning_object add column if not exists title text not null default '';
alter table learning_object add column if not exists description text not null default '';
alter table learning_object add column if not exists duration text not null default '';
alter table learning_object add column if not exists kind text not null default 'native-web-package';
alter table learning_object add column if not exists module_path text not null default '';
alter table learning_object add column if not exists content_profile text;
alter table learning_object add column if not exists authored_by text;
alter table learning_object add column if not exists active_package_version_id uuid;
alter table learning_object add column if not exists updated_at timestamptz not null default now();
alter table learning_object add column if not exists retired_at timestamptz;
create index if not exists learning_object_repository_idx on learning_object(repository_id, status);

-- An object version is the immutable unit a descriptor and an attempt bind to. Before this table the
-- runtime minted a fresh random object_version_id on every launch, so two attempts at the same
-- content recorded different versions and no evidence statement could be grouped by what was
-- actually delivered.
create table if not exists object_version (
  object_version_id uuid primary key,
  object_id uuid not null references learning_object(object_id) on delete cascade,
  semver text not null,
  package_version_id uuid not null,
  status text not null check (status in ('DRAFT','VALIDATING','PUBLISHED','SUPERSEDED','RETIRED')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (object_id, semver)
);
create index if not exists object_version_object_idx on object_version(object_id, status);

-- A shared player package (the quiz player, for instance) is owned by no single learning object, so
-- object_id has to be nullable. The original column was declared not null against a catalogue that
-- had no shared packages in it.
alter table package_version alter column object_id drop not null;
alter table package_version add column if not exists shared_player boolean not null default false;
alter table package_version add column if not exists module_path text not null default '';
alter table package_version add column if not exists integrity_algorithm text not null default 'sha256';
create index if not exists package_version_object_idx on package_version(object_id);

-- Structured content for objects whose payload is data rather than code. The marking key lives here
-- and is served only on the learner-facing content route; no administration or agent-facing surface
-- reads this column.
create table if not exists learning_object_content (
  object_id uuid primary key references learning_object(object_id) on delete cascade,
  content_profile text not null check (content_profile in ('quiz-json-v1')),
  content_version text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Attempts
-- ---------------------------------------------------------------------------

-- The original schema recognised three attempt states. The lifecycle the specification describes has eight, and
-- two of the missing ones are load-bearing in production: an attempt that is never completed has to
-- reach a terminal state rather than sitting in STARTED for ever.
alter table attempt drop constraint if exists attempt_status_check;
alter table attempt add constraint attempt_status_check
  check (status in ('CREATED','STARTED','SUSPENDED','RESUMED','COMPLETED','ABANDONED','EXPIRED','VOIDED'));
alter table attempt add column if not exists object_id uuid;
alter table attempt add column if not exists expires_at timestamptz;
alter table attempt add column if not exists updated_at timestamptz not null default now();
alter table attempt add column if not exists terminated_at timestamptz;
alter table attempt add column if not exists governed_by_launch_policy jsonb;
alter table attempt add column if not exists package_pinned_by_object boolean not null default false;
alter table attempt add column if not exists source text not null default 'consumer';
-- Attempts are created before the catalogue row is necessarily reachable in every deployment shape
-- (a smart-link redemption, an internal batch assignment), and losing an attempt to a referential
-- race would lose a learner's work. Integrity is enforced at write time in the store instead.
alter table attempt drop constraint if exists attempt_package_version_id_fkey;
alter table attempt drop constraint if exists attempt_repository_id_fkey;
create index if not exists attempt_pseudonym_idx on attempt(pseudonymous_subject_id);
create index if not exists attempt_object_idx on attempt(object_id);
create index if not exists attempt_open_idx on attempt(expires_at) where status in ('CREATED','STARTED','SUSPENDED','RESUMED');

-- ---------------------------------------------------------------------------
-- Launches and idempotency
-- ---------------------------------------------------------------------------

create table if not exists launch (
  launch_id uuid primary key,
  attempt_id uuid not null,
  repository_id uuid not null,
  object_id uuid not null,
  consumer_id text not null,
  launch_mode text not null,
  expires_at timestamptz not null,
  correlation_id text not null,
  created_at timestamptz not null default now()
);
create index if not exists launch_attempt_idx on launch(attempt_id);

-- Idempotency is mandatory on every state-changing surface, so the record of a replayed response has
-- to outlive the process that produced it. Scoped by surface so the same key used against two
-- different endpoints cannot replay one another's response.
create table if not exists idempotency_record (
  scope text not null,
  idempotency_key text not null,
  request_fingerprint text not null,
  response jsonb not null,
  status_code integer not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (scope, idempotency_key)
);
create index if not exists idempotency_record_expiry_idx on idempotency_record(expires_at);

-- ---------------------------------------------------------------------------
-- Smart links
-- ---------------------------------------------------------------------------

create table if not exists smart_link (
  smart_link_id uuid primary key,
  object_id uuid not null references learning_object(object_id) on delete cascade,
  -- Only the hash is stored. A durable, login-free credential kept in plaintext in the database is a
  -- standing exposure; the token itself is returned to the admin once, at creation.
  token_hash text not null unique,
  token_prefix text not null,
  created_by_pseudonym text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by_pseudonym text,
  last_redeemed_at timestamptz,
  redemption_count bigint not null default 0
);
create unique index if not exists smart_link_active_object_uniq on smart_link(object_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Assignments
-- ---------------------------------------------------------------------------

create table if not exists assignment (
  assignment_id uuid primary key,
  object_id uuid not null,
  source text not null,
  created_by_pseudonym text,
  created_at timestamptz not null default now()
);
create index if not exists assignment_object_idx on assignment(object_id);

-- Pseudonyms only, exactly as the in-memory shape held them: the platform identifiers used to derive
-- them are returned to the calling service once and never stored.
create table if not exists assignment_actor (
  assignment_id uuid not null references assignment(assignment_id) on delete cascade,
  pseudonym text not null,
  primary key (assignment_id, pseudonym)
);

-- ---------------------------------------------------------------------------
-- Evidence outbox
-- ---------------------------------------------------------------------------

alter table evidence_outbox drop constraint if exists evidence_outbox_status_check;
alter table evidence_outbox add constraint evidence_outbox_status_check
  check (status in ('PENDING','IN_FLIGHT','FORWARDED','FAILED','DEAD_LETTER'));
alter table evidence_outbox drop constraint if exists evidence_outbox_attempt_id_fkey;
alter table evidence_outbox add column if not exists object_id uuid;
alter table evidence_outbox add column if not exists actor_pseudonym text;
alter table evidence_outbox add column if not exists verb_id text;
alter table evidence_outbox add column if not exists next_attempt_at timestamptz not null default now();
alter table evidence_outbox add column if not exists claimed_at timestamptz;
alter table evidence_outbox add column if not exists claimed_by text;
alter table evidence_outbox add column if not exists dead_lettered_at timestamptz;
alter table evidence_outbox add column if not exists statement_timestamp timestamptz;
alter table evidence_outbox alter column attempt_id drop not null;
drop index if exists evidence_outbox_pending_idx;
create index if not exists evidence_outbox_due_idx on evidence_outbox(next_attempt_at) where status in ('PENDING','FAILED');
create index if not exists evidence_outbox_object_idx on evidence_outbox(object_id);
create index if not exists evidence_outbox_actor_idx on evidence_outbox(actor_pseudonym);
create index if not exists evidence_outbox_created_idx on evidence_outbox(created_at);

-- Evidence is corrected by a superseding statement, never by a destructive overwrite, so the payload
-- of an accepted statement is frozen. Delivery bookkeeping on the same row stays writable.
create or replace function evidence_outbox_payload_immutable() returns trigger as $$
begin
  if new.payload is distinct from old.payload
    or new.statement_id is distinct from old.statement_id
    or new.created_at is distinct from old.created_at
  then
    raise exception 'EVIDENCE_STATEMENT_IMMUTABLE';
  end if;
  return new;
end;
$$ language plpgsql;
drop trigger if exists evidence_outbox_no_payload_update on evidence_outbox;
create trigger evidence_outbox_no_payload_update before update on evidence_outbox
  for each row execute function evidence_outbox_payload_immutable();

drop trigger if exists evidence_outbox_no_delete on evidence_outbox;
create or replace function evidence_outbox_no_delete() returns trigger as $$
begin
  raise exception 'EVIDENCE_STATEMENT_IMMUTABLE';
end;
$$ language plpgsql;
create trigger evidence_outbox_no_delete before delete on evidence_outbox
  for each row execute function evidence_outbox_no_delete();

-- ---------------------------------------------------------------------------
-- Service health
-- ---------------------------------------------------------------------------

-- Lets a readiness probe and an operator see which workers are alive without reading logs.
create table if not exists worker_heartbeat (
  worker text primary key,
  instance text not null,
  last_seen_at timestamptz not null default now(),
  detail jsonb
);
