-- Marketplace: an object opts in to being discoverable outside its own repository, and an
-- administrator can bookmark ("import") a listed object from another repository so it becomes part
-- of the set they can assign to their own classes.
--
-- Nothing here copies content. An object still belongs to exactly one repository, stays owned and
-- versioned by whoever authored it, and its content lives exactly where it always did. Assignment
-- (see admin/classes.ts) already resolves an object_id independent of the caller's own repository,
-- so a bookmark is only ever a discovery record for "what should Assign work show me" — never a
-- duplicate of the object itself.
alter table learning_object add column marketplace_listed boolean not null default false;

create table marketplace_import (
  imported_by_pseudonym text not null,
  object_id uuid not null references learning_object(object_id),
  imported_at timestamptz not null default now(),
  primary key (imported_by_pseudonym, object_id)
);
create index marketplace_import_object_idx on marketplace_import(object_id);
