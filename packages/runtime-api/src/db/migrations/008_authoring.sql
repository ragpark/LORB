-- Authoring: a content version that an edit supersedes rather than overwrites.
--
-- `learning_object_content` holds one row per object, and editing a quiz used to mean there was
-- nowhere for the previous questions to go. That is fine until a learner has already answered them:
-- the attempt and every xAPI statement it produced name an object version, and reading that evidence
-- back against content that has since been rewritten reports the learner against questions they
-- never saw. So each content version is now written once, immutably, and `learning_object_content`
-- becomes the pointer to the current one.
create table if not exists learning_object_content_version (
  object_id uuid not null references learning_object(object_id) on delete cascade,
  content_profile text not null check (content_profile in ('quiz-json-v1')),
  content_version text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (object_id, content_version)
);

-- Whatever content already exists is the first version of itself.
insert into learning_object_content_version (object_id, content_profile, content_version, payload, created_at)
select object_id, content_profile, content_version, payload, created_at
  from learning_object_content
    on conflict (object_id, content_version) do nothing;

-- An object version now names the content version it delivers.
--
-- Without it, a launch descriptor pins an object version whose content the player then fetches by
-- object id — so an edit published mid-attempt would change the questions under a learner who had
-- already answered half of them, and the evidence would name a version whose content had moved on.
-- The column is nullable: a code-bearing object delivers a package, not content, and has none.
alter table object_version add column if not exists content_version text;

update object_version ov
   set content_version = c.content_version
  from learning_object_content c
 where c.object_id = ov.object_id
   and ov.content_version is null;
