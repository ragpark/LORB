-- NOT PRODUCTION — BLK-02, BLK-03 and BLK-07 ARE NOW IMPLICATED, NOT MERELY OPEN.
--
-- packages/stub-roster/STUB.md states that LORB-001 has no class, cohort or roster concept of its
-- own, and that a real roster/entitlement source requires the accountable owner (BLK-03), the
-- privacy design for holding class membership (BLK-07), and the portfolio-reuse decision (BLK-02).
-- These tables are that roster source. They were added on an explicit instruction to build one; the
-- three blockers must be closed before this schema holds data about any real person.
--
-- Design note carried into the table shapes below: a learner's platform identifier and their LORB
-- pseudonym are never stored in the same row, and the pseudonym is never stored at all. Results are
-- joined back to a class by recomputing the pseudonym from the identifier at read time, through the
-- unchanged pseudonymisation function. Persisting the pair would create a standing re-identification
-- table, which is exactly the artefact BLK-07 exists to govern.

create table class (
  class_id uuid primary key,
  name text not null,
  year_group text,
  subject text,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','ARCHIVED')),
  created_by_pseudonym text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index class_created_by_idx on class(created_by_pseudonym);

-- learner_ref is the identifier the upstream identity source issues, in the same shape the synthetic
-- IES accepts, so a roster entry and that learner's own login derive the same pseudonym.
-- display_name is a teacher-facing label only. It must never reach a launch descriptor or an xAPI
-- statement; the descriptor schema rejects PII fields and the anti-requirement suite enforces it.
create table class_learner (
  class_id uuid not null references class(class_id) on delete cascade,
  learner_ref text not null,
  display_name text not null,
  added_by_pseudonym text not null,
  added_at timestamptz not null default now(),
  primary key (class_id, learner_ref)
);

create table class_assignment (
  assignment_id uuid primary key,
  class_id uuid not null references class(class_id) on delete cascade,
  object_id uuid not null,
  assigned_by_pseudonym text not null,
  idempotency_key text not null,
  learner_count integer not null,
  created_at timestamptz not null default now(),
  unique (class_id, idempotency_key)
);
create index class_assignment_class_idx on class_assignment(class_id);
create index class_assignment_object_idx on class_assignment(object_id);

-- Recent teaching topics, so the MCP class:// resources keep working against a real class rather
-- than the synthetic seed. Content about the curriculum, not about people.
create table class_topic (
  class_topic_id uuid primary key,
  class_id uuid not null references class(class_id) on delete cascade,
  topic text not null,
  taught_on date not null,
  summary text not null default '',
  created_at timestamptz not null default now()
);
create index class_topic_class_idx on class_topic(class_id, taught_on desc);
