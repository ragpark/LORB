-- Widens the two content-profile check constraints to admit the three new media kinds registered
-- alongside quizzes: video, document (Office-file-as-page-images), and audio. Storage was already
-- generic (payload is JSONB in both tables); only the enumerated set of allowed profile strings was
-- quiz-only, from migrations 007 and 008.
alter table learning_object_content drop constraint if exists learning_object_content_content_profile_check;
alter table learning_object_content add constraint learning_object_content_content_profile_check
  check (content_profile in ('quiz-json-v1', 'video-json-v1', 'document-json-v1', 'audio-json-v1'));

alter table learning_object_content_version drop constraint if exists learning_object_content_version_content_profile_check;
alter table learning_object_content_version add constraint learning_object_content_version_content_profile_check
  check (content_profile in ('quiz-json-v1', 'video-json-v1', 'document-json-v1', 'audio-json-v1'));
