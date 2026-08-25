import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const RUNTIME_BASE = 'http://localhost:3000/api/v1/runtime';
const IES = 'http://localhost:4000';

async function signIn(page: import('@playwright/test').Page, identity: string) {
  await page.goto('/');
  await page.locator('select').selectOption(identity);
  await page.getByText('Sign in as administrator').click();
  await expect(page.locator('.operator')).toBeVisible();
}

async function requestAndExecute(page: import('@playwright/test').Page, requester: string, approver: string, requestAction: () => Promise<void>) {
  await signIn(page, requester);
  await requestAction();
  await page.getByText('Request', { exact: false }).last().click();
  await signIn(page, approver);
  await page.locator('aside').getByRole('button', { name: 'Approvals', exact: true }).click();
  await page.getByRole('button', { name: 'Approve' }).first().click();
  await signIn(page, requester);
  await page.locator('aside').getByRole('button', { name: 'Approvals', exact: true }).click();
  await page.getByRole('button', { name: 'Execute' }).first().click();
}

test('LORB-001 Administration workspace happy path (Section 15.6)', async ({ page }) => {
  const unique = Date.now();

  // 1. Sign in as synthetic admin A.
  await signIn(page, 'synthetic-admin-a');
  await expect(page.locator('.draft-banner')).toContainText('DRAFT');

  // Design-target accessibility check on the Overview page (Section 15.10 — design target, not a conformance claim).
  const axeResults = await new AxeBuilder({ page }).analyze();
  expect(axeResults.violations, JSON.stringify(axeResults.violations, null, 2)).toEqual([]);

  // 2. Create a repository.
  await page.locator('aside').getByRole('button', { name: 'Repositories', exact: true }).click();
  const slug = `happy-${unique}`;
  await page.locator('input[pattern="(?:[a-z0-9]|-){3,32}"]').fill(slug);
  const repositoryName = `Happy Path Repository ${unique}`;
  await page.locator('input[minlength="3"][maxlength="120"]').first().fill(repositoryName);
  await page.getByText('Create repository').click();
  await expect(page.getByText(repositoryName)).toBeVisible();
  await page.getByText(repositoryName).click();

  // 3. Grant repository_operator membership to synthetic admin B (using B's known pseudonym from a prior whoami — for
  //    this test we grant using B's pseudonym fetched via the API directly, since the UI never displays another
  //    admin's pseudonym until they've acted).
  const bWhoAmI = await page.request.fetch(`http://localhost:4000/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, data: { subject: 'synthetic-admin-b', role: 'admin' } });
  const bToken = (await bWhoAmI.json()).access_token as string;
  const bIdentity = await page.request.fetch('http://localhost:3000/api/v1/admin/whoami', { headers: { authorization: `Bearer ${bToken}` } });
  const bPseudonym = (await bIdentity.json()).pseudonym as string;
  await page.getByRole('tab', { name: 'Memberships' }).click();
  await page.locator('.form input').first().fill(bPseudonym);
  await page.getByText('Grant membership').click();
  await expect(page.getByText(bPseudonym)).toBeVisible();

  // 4. Register a player and a version pointing at the Player Shell's own module origin (the allow-listed one).
  await page.locator('aside').getByRole('button', { name: 'Players', exact: true }).click();
  const playerName = `Happy Path Player ${unique}`;
  await page.locator('input[minlength="3"][maxlength="120"]').first().fill(playerName);
  await page.getByText('Register player').click();
  await page.getByText(playerName).click();
  await page.getByRole('tab', { name: 'Register version' }).click();
  await page.locator('input[type="url"]').first().fill('http://localhost:3200/module/index.html');
  await page.locator('input[pattern="[0-9a-fA-F]+"]').fill('deadbeefcafe');
  await page.getByRole('button', { name: 'Register version' }).click();
  await page.getByRole('tab', { name: 'Versions' }).click();
  await expect(page.getByText('TESTING')).toBeVisible();

  // 5-9. Request approve as A, approve as B, execute as A.
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText(/separation of duties/i)).toBeVisible();
  await page.getByRole('button', { name: 'Request Approve' }).click();
  await signIn(page, 'synthetic-admin-b');
  await page.locator('aside').getByRole('button', { name: 'Approvals', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approve' }).first()).toBeEnabled();
  await page.getByRole('button', { name: 'Approve' }).first().click();
  await signIn(page, 'synthetic-admin-a');
  await page.locator('aside').getByRole('button', { name: 'Approvals', exact: true }).click();
  await page.getByRole('button', { name: 'Execute' }).first().click();

  // Activate the version the same way (approve + execute cycle).
  await page.locator('aside').getByRole('button', { name: 'Players', exact: true }).click();
  await page.getByText(playerName).click();
  await expect(page.getByText('APPROVED')).toBeVisible();
  await page.getByRole('button', { name: 'Activate' }).click();
  await page.getByRole('button', { name: 'Request Activate' }).click();
  await signIn(page, 'synthetic-admin-b');
  await page.locator('aside').getByRole('button', { name: 'Approvals', exact: true }).click();
  await page.getByRole('button', { name: 'Approve' }).first().click();
  await signIn(page, 'synthetic-admin-a');
  await page.locator('aside').getByRole('button', { name: 'Approvals', exact: true }).click();
  await page.getByRole('button', { name: 'Execute' }).first().click();
  await page.locator('aside').getByRole('button', { name: 'Players', exact: true }).click();
  await page.getByText(playerName).click();
  await expect(page.getByText('ACTIVE', { exact: true })).toBeVisible();

  // Fetch the created player/version IDs and repository ID for the launch policy rule via the API (the UI shows
  // them truncated in places; the API is the source of truth for what the test needs to route to).
  const playersRes = await page.request.fetch('http://localhost:3000/api/v1/admin/players', { headers: { authorization: `Bearer ${await getToken(page, 'synthetic-admin-a')}` } });
  const players = (await playersRes.json()).items as { player_id: string; display_name: string }[];
  const player = players.find((p) => p.display_name === playerName)!;
  const playerDetail = await page.request.fetch(`http://localhost:3000/api/v1/admin/players/${player.player_id}`, { headers: { authorization: `Bearer ${await getToken(page, 'synthetic-admin-a')}` } });
  const playerVersionId = (await playerDetail.json()).versions[0].player_version_id as string;
  const reposRes = await page.request.fetch('http://localhost:3000/api/v1/admin/repositories', { headers: { authorization: `Bearer ${await getToken(page, 'synthetic-admin-a')}` } });
  const repos = (await reposRes.json()).items as { repository_id: string; display_name: string }[];
  const repository = repos.find((r) => r.display_name === repositoryName)!;

  // 10-11. Create a launch policy, add a version routing to the newly-activated player version, publish and activate it.
  await page.locator('aside').getByRole('button', { name: 'Launch policies', exact: true }).click();
  const policyName = `Happy Path Policy ${unique}`;
  await page.locator('input[minlength="3"][maxlength="120"]').first().fill(policyName);
  await page.getByText('Create launch policy').click();
  await page.getByText(policyName).click();
  await page.getByRole('tab', { name: 'Add version' }).click();
  const inputs = page.locator('.form input');
  await inputs.nth(1).fill(repository.repository_id);
  await inputs.nth(2).fill(player.player_id);
  await inputs.nth(3).fill(playerVersionId);
  await page.getByText('Add draft version').click();
  await page.getByRole('tab', { name: 'Versions' }).click();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('button', { name: 'Request Publish' }).click();
  await signIn(page, 'synthetic-admin-b');
  await page.locator('aside').getByRole('button', { name: 'Approvals', exact: true }).click();
  await page.getByRole('button', { name: 'Approve' }).first().click();
  await signIn(page, 'synthetic-admin-a');
  await page.locator('aside').getByRole('button', { name: 'Approvals', exact: true }).click();
  await page.getByRole('button', { name: 'Execute' }).first().click();
  await page.locator('aside').getByRole('button', { name: 'Launch policies', exact: true }).click();
  await page.getByText(policyName).click();
  await page.getByRole('button', { name: 'Activate' }).click();
  await page.getByRole('button', { name: 'Request Activate' }).click();
  await signIn(page, 'synthetic-admin-b');
  await page.locator('aside').getByRole('button', { name: 'Approvals', exact: true }).click();
  await page.getByRole('button', { name: 'Approve' }).first().click();
  await signIn(page, 'synthetic-admin-a');
  await page.locator('aside').getByRole('button', { name: 'Approvals', exact: true }).click();
  await page.getByRole('button', { name: 'Execute' }).first().click();

  // The Execute click's mutation is async and doesn't itself change what's on screen, so wait for
  // the policy to actually be ACTIVE server-side before triggering a launch against it — otherwise
  // the launch can race ahead of the activation and the resolver won't find a match yet.
  await expect
    .poll(async () => {
      const res = await page.request.fetch(`http://localhost:3000/api/v1/admin/launch-policies/${await getLaunchPolicyId(page, policyName)}`, {
        headers: { authorization: `Bearer ${await getToken(page, 'synthetic-admin-a')}` },
      });
      return (await res.json()).status;
    })
    .toBe('ACTIVE');

  // 12-13. Trigger a launch through the Runtime API (the same endpoint the Learner Portal calls) and verify the
  // resulting attempt carries the "Governed by Launch Policy" reference.
  const learnerLogin = await page.request.fetch(`${IES}/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, data: { subject: 'synthetic-happy-path-learner' } });
  const learnerToken = (await learnerLogin.json()).access_token as string;
  const launch = await page.request.fetch(`${RUNTIME_BASE}/launches`, {
    method: 'POST',
    headers: { authorization: `Bearer ${learnerToken}`, 'idempotency-key': `${unique}` },
    data: { contract_version: '1.0', consumer_id: 'learner-portal', repository_id: repository.repository_id, object_id: crypto.randomUUID(), requested_launch_mode: 'embedded-iframe', locale: 'en-GB' },
  });
  expect(launch.status()).toBe(201);
  const launchBody = await launch.json();
  const attempt = await page.request.fetch(`${RUNTIME_BASE}/attempts/${launchBody.attempt_id}`);
  const attemptBody = await attempt.json();
  expect(attemptBody.governed_by_launch_policy).toMatchObject({ display_name: policyName });
});

async function getToken(page: import('@playwright/test').Page, subject: string): Promise<string> {
  const res = await page.request.fetch('http://localhost:4000/dev-login', { method: 'POST', headers: { 'content-type': 'application/json' }, data: { subject, role: 'admin' } });
  return (await res.json()).access_token;
}

async function getLaunchPolicyId(page: import('@playwright/test').Page, displayName: string): Promise<string> {
  const res = await page.request.fetch('http://localhost:3000/api/v1/admin/launch-policies', { headers: { authorization: `Bearer ${await getToken(page, 'synthetic-admin-a')}` } });
  const items = (await res.json()).items as { launch_policy_id: string; display_name: string }[];
  return items.find((p) => p.display_name === displayName)!.launch_policy_id;
}
