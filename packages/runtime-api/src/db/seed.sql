-- Example content, applied only when SEED_EXAMPLE_CONTENT is set. Production configuration refuses
-- that flag, so a deployed catalogue holds only what was registered through the Publisher API.
--
-- Safe to run repeatedly: every insert is idempotent on its primary key.

insert into repository (repository_id, slug, display_name, status)
values ('b6f1c9d2-6e3a-4f1b-9a7d-1e2f3a4b5c6d', 'default', 'Default repository', 'ACTIVE')
on conflict (repository_id) do nothing;

-- The shared quiz player: one fixed, already-reviewed package that every authored quiz points at.
-- It belongs to no learning object, which is why package_version.object_id is nullable.
insert into package_version (
  package_version_id, package_id, object_id, semver, sha256,
  delivery_profile, entry_point, module_path, status, published_at, shared_player
)
values (
  '5cbe1b8a-2f2a-4a5c-9f8b-6d1c0a7e4b21', '5cbe1b8a-2f2a-4a5c-9f8b-6d1c0a7e4b22', null,
  '1.0.0', '9f0c4c9d0f1a4a4b8f0f7b2d0a1c6e3f5d8b2a7c4e9f1b3d6a8c0e2f4b6d8a10',
  'native-web-package', '/modules/quiz-player/index.html', '/modules/quiz-player/index.html',
  'PUBLISHED', '2026-08-20T08:00:00Z', true
)
on conflict (package_version_id) do nothing;

insert into learning_object (
  object_id, repository_id, active_object_version_id, active_package_version_id,
  status, title, description, duration, kind, module_path, created_at
)
values
  (
    'c8a2d3e4-7f4b-4a2c-8b6e-2f3a4b5c6d7e', 'b6f1c9d2-6e3a-4f1b-9a7d-1e2f3a4b5c6d',
    'd9b3e4f5-8a5c-4b3d-9c7f-3a4b5c6d7e8f', 'eaa4f506-9b6d-4c4e-ad80-4b5c6d7e8f90',
    'PUBLISHED', 'Maths foundations: ratios and proportion',
    'A native-web-package activity with a single completion checkpoint.',
    '20 minutes', 'native-web-package', '/module/index.html', '2026-08-12T09:22:00Z'
  ),
  (
    '9fa1bff9-e205-44ee-a08d-df208bb1c8c4', 'b6f1c9d2-6e3a-4f1b-9a7d-1e2f3a4b5c6d',
    '7e08c389-8166-400c-920a-4d2d6166fce3', '6978ab59-f291-4de4-ac25-d51218fc3751',
    'PUBLISHED', 'Reflective Practice Studio',
    'A React web experience that emits xAPI statements for delivery to the learning record store.',
    '8 minutes', 'react-xapi-experience', '/modules/reflective-practice-studio/index.html', '2026-08-13T11:05:00Z'
  ),
  (
    '1d3cf15e-653b-446e-8398-a7b5fe0d32d9', 'b6f1c9d2-6e3a-4f1b-9a7d-1e2f3a4b5c6d',
    '9592a8f2-e82b-48ea-b5a4-a0fa909ec111', '7a78d88e-4ef2-4bce-a4a7-8b4d19d22013',
    'PUBLISHED', 'Career Coach Check-in',
    'A chatbot-style coaching tool that guides a learner through a short reflective conversation.',
    '5 minutes', 'coaching-chatbot', '/modules/career-coach-chat/index.html', '2026-08-13T11:12:00Z'
  )
on conflict (object_id) do nothing;

insert into package_version (
  package_version_id, package_id, object_id, semver, sha256,
  delivery_profile, entry_point, module_path, status, published_at
)
values
  (
    'eaa4f506-9b6d-4c4e-ad80-4b5c6d7e8f90', '40000000-0000-4000-8000-000000000001',
    'c8a2d3e4-7f4b-4a2c-8b6e-2f3a4b5c6d7e', '1.4.0',
    '4f3c9a182fd1b9534f3c9a182fd1b9534f3c9a182fd1b9534f3c9a182fd1b953',
    'native-web-package', '/module/index.html', '/module/index.html', 'PUBLISHED', '2026-08-12T10:04:00Z'
  ),
  (
    '6978ab59-f291-4de4-ac25-d51218fc3751', '40000000-0000-4000-8000-000000000002',
    '9fa1bff9-e205-44ee-a08d-df208bb1c8c4', '1.0.0',
    '62f030c5bd0f1fd606f1548a3070797730d025cb330e32837519098c44f0bd13',
    'native-web-package', '/modules/reflective-practice-studio/index.html',
    '/modules/reflective-practice-studio/index.html', 'PUBLISHED', '2026-08-13T11:06:00Z'
  ),
  (
    '7a78d88e-4ef2-4bce-a4a7-8b4d19d22013', '40000000-0000-4000-8000-000000000003',
    '1d3cf15e-653b-446e-8398-a7b5fe0d32d9', '1.0.0',
    '4ae991392399628e60ae327c2215fddbf5d082c80ff9aaf6e9f047886f6edd8b',
    'native-web-package', '/modules/career-coach-chat/index.html',
    '/modules/career-coach-chat/index.html', 'PUBLISHED', '2026-08-13T11:13:00Z'
  )
on conflict (package_version_id) do nothing;

-- The immutable versions a descriptor and an attempt bind to.
insert into object_version (object_version_id, object_id, semver, package_version_id, status, published_at)
values
  ('d9b3e4f5-8a5c-4b3d-9c7f-3a4b5c6d7e8f', 'c8a2d3e4-7f4b-4a2c-8b6e-2f3a4b5c6d7e', '1.4.0', 'eaa4f506-9b6d-4c4e-ad80-4b5c6d7e8f90', 'PUBLISHED', '2026-08-12T10:04:00Z'),
  ('7e08c389-8166-400c-920a-4d2d6166fce3', '9fa1bff9-e205-44ee-a08d-df208bb1c8c4', '1.0.0', '6978ab59-f291-4de4-ac25-d51218fc3751', 'PUBLISHED', '2026-08-13T11:06:00Z'),
  ('9592a8f2-e82b-48ea-b5a4-a0fa909ec111', '1d3cf15e-653b-446e-8398-a7b5fe0d32d9', '1.0.0', '7a78d88e-4ef2-4bce-a4a7-8b4d19d22013', 'PUBLISHED', '2026-08-13T11:13:00Z')
on conflict (object_version_id) do nothing;
