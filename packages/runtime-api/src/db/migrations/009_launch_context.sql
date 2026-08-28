-- Launch context: publisher-authored configuration an object version carries into its own launch.
--
-- A theme token, small named settings — data about the experience, never the learner's business and
-- never a place for secrets or resource URLs. It lives on `object_version` for the same reason
-- `content_version` does: a descriptor pins the version, so a context edit published mid-attempt
-- cannot restyle or reconfigure the experience under a learner who is already inside it. Setting it
-- publishes a new version; the column is nullable because most versions carry none.
alter table object_version add column if not exists launch_context jsonb;
