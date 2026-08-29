-- Version-pinned smart links: a superseded version stays shareable as an artefact.
--
-- A smart link used to mean "this object, at whatever version is active when the link is opened".
-- That is still the default (object_version_id null), and it is still limited to one active link
-- per object. A link may now instead pin one object version, so publishing again moves the active
-- pointer without moving what an already-shared link delivers — one active pinned link per version.
alter table smart_link add column if not exists object_version_id uuid references object_version(object_version_id);

drop index if exists smart_link_active_object_uniq;
create unique index if not exists smart_link_active_object_uniq
  on smart_link(object_id) where revoked_at is null and object_version_id is null;
create unique index if not exists smart_link_active_version_uniq
  on smart_link(object_id, object_version_id) where revoked_at is null and object_version_id is not null;
