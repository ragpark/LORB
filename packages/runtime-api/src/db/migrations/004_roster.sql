-- The roster: classes, their learners, taught topics, and the assignment of a learning object to a
-- whole class.
--
-- The privacy shape is carried into the table definitions themselves, and it is the reason several
-- reads are more expensive than they need to be: a learner's platform identifier and their LORB
-- pseudonym are never stored in the same row, and the pseudonym is never stored at all. Results are
-- joined back to a class by recomputing the pseudonym from the identifier at read time, through the
-- unchanged pseudonymisation function.
--
-- Persisting the pair would make those reads a simple join. It would also create a standing
-- re-identification table sitting in the database, which is exactly the artefact pseudonymising the
-- evidence was meant to avoid. The cost is accepted deliberately.

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

-- learner_ref is the identifier the identity provider issues for that learner, so a roster entry and
-- that learner's own sign-in derive the same pseudonym.
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

-- Recent teaching topics, so generated content can be relevant to what a class has actually been
-- taught. Content about the curriculum, not about people.
create table class_topic (
  class_topic_id uuid primary key,
  class_id uuid not null references class(class_id) on delete cascade,
  topic text not null,
  taught_on date not null,
  summary text not null default '',
  created_at timestamptz not null default now()
);
create index class_topic_class_idx on class_topic(class_id, taught_on desc);
