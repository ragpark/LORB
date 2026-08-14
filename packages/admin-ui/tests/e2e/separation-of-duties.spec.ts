import { test, expect } from '@playwright/test';

async function signIn(page: import('@playwright/test').Page, identity: string) {
  await page.goto('/');
  await page.locator('select').selectOption(identity);
  await page.getByText('Sign in as administrator').click();
  await expect(page.locator('.operator')).toBeVisible();
}

test('separation-of-duties block path (Section 15.7)', async ({ page }) => {
  const unique = Date.now();

  // 1-5: sign in as A, create a player + version, request approval.
  await signIn(page, 'synthetic-admin-a');
  await page.locator('aside').getByRole('button', { name: 'Players', exact: true }).click();
  const playerName = `SoD Block Player ${unique}`;
  await page.locator('input[minlength="3"][maxlength="120"]').first().fill(playerName);
  await page.getByText('Register player').click();
  await page.getByText(playerName).click();
  await page.getByRole('tab', { name: 'Register version' }).click();
  await page.locator('input[type="url"]').first().fill('http://localhost:3200/module/index.html');
  await page.locator('input[pattern="[0-9a-fA-F]+"]').fill('feedface');
  await page.getByRole('button', { name: 'Register version' }).click();
  await page.getByRole('tab', { name: 'Versions' }).click();
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.getByRole('button', { name: 'Request Approve' }).click();

  // 2. Admin A attempts to approve their own request — the UI must disable it.
  await page.locator('aside').getByRole('button', { name: 'Approvals', exact: true }).click();
  const approveButton = page.getByRole('button', { name: 'Approve' }).first();
  await expect(approveButton).toBeDisabled();

  // Confirm the API also rejects it directly with SEPARATION_OF_DUTIES_REQUIRED, since a disabled
  // button alone doesn't prove the server-side control — this is layer 1 of 3 (Section 12); the API
  // (layer 2) and Postgres CHECK constraint (layer 3) are covered by tests/runtime-api/admin-enforcement.spec.ts.
  const idLine = await page.locator('.approval-card').first().locator('p').nth(0).textContent();
  void idLine;
  const pending = await page.request.fetch('http://localhost:3000/api/v1/admin/approval-requests?status=PENDING', {
    headers: { authorization: `Bearer ${await getToken(page, 'synthetic-admin-a')}` },
  });
  const pendingItems = (await pending.json()).items as { approval_request_id: string; action_type: string }[];
  const target = pendingItems.find((i) => i.action_type === 'player_version.approve')!;
  const selfApprove = await page.request.fetch(`http://localhost:3000/api/v1/admin/approval-requests/${target.approval_request_id}/approve`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await getToken(page, 'synthetic-admin-a')}`, 'idempotency-key': `${unique}-self` },
  });
  expect(selfApprove.status()).toBe(409);
  const problem = await selfApprove.json();
  expect(problem.code).toBe('SEPARATION_OF_DUTIES_REQUIRED');
});

async function getToken(page: import('@playwright/test').Page, subject: string): Promise<string> {
  const res = await page.request.fetch('http://localhost:4000/dev-login', { method: 'POST', headers: { 'content-type': 'application/json' }, data: { subject, role: 'admin' } });
  return (await res.json()).access_token;
}
