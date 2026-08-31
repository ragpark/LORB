-- Widens the two content-profile check constraints the same way migrations 011 and 014 did,
-- admitting the new external-embed-v1 profile. No new columns: an external embed carries no
-- credential to denormalise the way lti_client_id/lti_deployment_id do for an lti-tool.
alter table learning_object_content drop constraint if exists learning_object_content_content_profile_check;
alter table learning_object_content add constraint learning_object_content_content_profile_check
  check (content_profile in ('quiz-json-v1', 'video-json-v1', 'document-json-v1', 'audio-json-v1', 'lti-tool-v1', 'external-embed-v1'));

alter table learning_object_content_version drop constraint if exists learning_object_content_version_content_profile_check;
alter table learning_object_content_version add constraint learning_object_content_version_content_profile_check
  check (content_profile in ('quiz-json-v1', 'video-json-v1', 'document-json-v1', 'audio-json-v1', 'lti-tool-v1', 'external-embed-v1'));
