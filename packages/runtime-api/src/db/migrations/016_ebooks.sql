-- Widens the two content-profile check constraints the same way migrations 011, 014 and 015 did,
-- admitting the new ebook-json-v1 profile: an EPUB 3 book read by the shared ebook reader. No new
-- columns — an ebook is a media kind like video/document/audio, one JSON payload naming the file.
alter table learning_object_content drop constraint if exists learning_object_content_content_profile_check;
alter table learning_object_content add constraint learning_object_content_content_profile_check
  check (content_profile in ('quiz-json-v1', 'video-json-v1', 'document-json-v1', 'audio-json-v1', 'ebook-json-v1', 'lti-tool-v1', 'external-embed-v1'));

alter table learning_object_content_version drop constraint if exists learning_object_content_version_content_profile_check;
alter table learning_object_content_version add constraint learning_object_content_version_content_profile_check
  check (content_profile in ('quiz-json-v1', 'video-json-v1', 'document-json-v1', 'audio-json-v1', 'ebook-json-v1', 'lti-tool-v1', 'external-embed-v1'));
