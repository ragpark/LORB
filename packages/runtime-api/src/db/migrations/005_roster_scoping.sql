-- Follow-up to 004_roster.sql. Two corrections from review, both of which were real:
--
-- 1. An assignment must remember who was in the class at the time. Reading the live roster to build
--    historical results showed newly added learners as "not started" on work they were never given,
--    and made removed learners vanish while learner_count still counted them.
--
--    The snapshot stores learner_ref only. It deliberately does not store the pseudonym, so the
--    property 004_roster.sql set out — that no row pairs an identifier with its pseudonym — still
--    holds. Results are still matched by recomputing.
--
-- 2. Class creation accepted an idempotency key, validated it, and then ignored it, so a retried
--    request created a second class. The key is now stored and replayed, as assignment already did.

create table class_assignment_learner (
  assignment_id uuid not null references class_assignment(assignment_id) on delete cascade,
  learner_ref text not null,
  primary key (assignment_id, learner_ref)
);

alter table class add column if not exists idempotency_key text;
create unique index class_creator_idempotency_uniq on class(created_by_pseudonym, idempotency_key) where idempotency_key is not null;

-- Every class operation is now scoped to the principal that created it, so this is the lookup path.
create index class_owner_status_idx on class(created_by_pseudonym, status);
