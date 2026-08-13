-- Stable review-environment fixtures. Safe to run after every deployment.
insert into repository (repository_id, slug, display_name, status)
values ('10000000-0000-4000-8000-000000000001', 'railway-demo', 'Railway Demo Repository', 'ACTIVE')
on conflict (repository_id) do nothing;

insert into learning_object (object_id, repository_id, status)
values (
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'PUBLISHED'
)
on conflict (object_id) do nothing;

insert into package_version (
  package_version_id, package_id, object_id, semver, sha256,
  delivery_profile, entry_point, status, published_at
)
values (
  '30000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  '1.0.0', repeat('0', 64), 'native-web-package',
  '/example-module/src/index.html', 'PUBLISHED', now()
)
on conflict (package_version_id) do nothing;
