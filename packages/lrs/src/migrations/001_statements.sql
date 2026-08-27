-- The learning record store's system of record.
--
-- A statement is immutable once accepted. That is not a preference: an LRS whose statements can be
-- edited cannot be used as evidence of anything, so the constraint is a database trigger rather than
-- a convention in application code. The one field that may change after insert is the voiding
-- marker, because xAPI voids a statement by asserting another one rather than by deleting it.

create table if not exists statement (
  statement_id uuid primary key,
  -- The order this store recorded things in, and the key a query pages by.
  --
  -- Not `stored_at`: a timestamptz holds microseconds, a JavaScript Date holds milliseconds, so a
  -- cursor built from a returned timestamp sorts *before* the row it came from and that row is
  -- handed out again on the next page. A sequence is exact on both sides of the driver.
  seq bigserial not null unique,
  -- Assigned here, never by the sender: `stored` is the store's own clock and is what a query
  -- paginates by. `timestamp` is the sender's, and may be older than the delivery that carried it.
  stored_at timestamptz not null default now(),
  timestamp timestamptz not null,

  -- Facets pulled out of the payload for querying. Everything else stays in `payload`.
  actor_pseudonym text,
  verb_id text not null,
  object_id text,
  registration uuid,
  repository_id uuid,
  attempt_id uuid,
  package_version_id uuid,
  correlation_id text,

  -- xAPI dedupe: a repeat PUT of the same statement is a no-op, and one that differs is a conflict.
  -- Comparing a digest rather than the JSON keeps that check cheap and key-order independent.
  payload_digest text not null,
  payload jsonb not null,

  voided boolean not null default false,
  voided_at timestamptz,
  voided_by uuid
);

create index if not exists statement_stored_idx on statement(stored_at desc);
create index if not exists statement_actor_idx on statement(actor_pseudonym, stored_at desc);
create index if not exists statement_verb_idx on statement(verb_id, stored_at desc);
create index if not exists statement_object_idx on statement(object_id, stored_at desc);
create index if not exists statement_attempt_idx on statement(attempt_id) where attempt_id is not null;
create index if not exists statement_repository_idx on statement(repository_id) where repository_id is not null;

-- A statement that voids another, recorded before its target is necessarily present: xAPI does not
-- guarantee delivery order, so a void can arrive first and has to be applied when its target lands.
create table if not exists statement_void (
  voiding_statement_id uuid primary key references statement(statement_id) on delete cascade,
  voided_statement_id uuid not null,
  recorded_at timestamptz not null default now()
);
create index if not exists statement_void_target_idx on statement_void(voided_statement_id);

-- Everything is frozen except the three voiding columns.
--
-- Written as an allow-list rather than a list of protected columns on purpose: naming the ones that
-- may not change leaves every column added later mutable by default, and it is the *facets* — the
-- actor, the verb, the object, the sequence a query pages by — that decide which statements a reader
-- is shown. A payload nobody can edit is worth little if the row's answer to "whose statement is
-- this?" can be edited instead.
create or replace function statement_is_immutable() returns trigger as $$
declare
  candidate statement%rowtype;
begin
  -- Take the proposed row, put the voiding columns back to what they were, and see whether anything
  -- is left over. If something is, the update changed more than a void and is refused.
  candidate := new;
  candidate.voided := old.voided;
  candidate.voided_at := old.voided_at;
  candidate.voided_by := old.voided_by;
  if row(candidate.*) is distinct from row(old.*) then
    raise exception 'STATEMENT_IMMUTABLE';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists statement_no_mutation on statement;
create trigger statement_no_mutation before update on statement
  for each row execute function statement_is_immutable();

create or replace function statement_no_delete() returns trigger as $$
begin
  raise exception 'STATEMENT_IMMUTABLE';
end;
$$ language plpgsql;

drop trigger if exists statement_no_removal on statement;
create trigger statement_no_removal before delete on statement
  for each row execute function statement_no_delete();
