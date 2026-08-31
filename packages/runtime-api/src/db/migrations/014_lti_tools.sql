-- Columns GET /api/v1/lti/authorize looks a tool up by. The full registration (title, description,
-- tool_name, oidc_login_url, target_link_uri, client_id, deployment_id) lives in
-- learning_object_content as JSON, same as every other data-authored kind; these two columns are a
-- denormalised, indexed copy of client_id/deployment_id purely so a third-party tool's redirect can
-- be resolved to a learning object with a query, not a JSON scan.
alter table learning_object add column lti_client_id text unique;
alter table learning_object add column lti_deployment_id text;

-- Widens the two content-profile check constraints the same way migration 011 did for the media
-- kinds, admitting the new lti-tool-v1 profile.
alter table learning_object_content drop constraint if exists learning_object_content_content_profile_check;
alter table learning_object_content add constraint learning_object_content_content_profile_check
  check (content_profile in ('quiz-json-v1', 'video-json-v1', 'document-json-v1', 'audio-json-v1', 'lti-tool-v1'));

alter table learning_object_content_version drop constraint if exists learning_object_content_version_content_profile_check;
alter table learning_object_content_version add constraint learning_object_content_version_content_profile_check
  check (content_profile in ('quiz-json-v1', 'video-json-v1', 'document-json-v1', 'audio-json-v1', 'lti-tool-v1'));
