import { expect, test } from '@playwright/test';

const PITCH = 'I want to create a platform that processes millions of transaction events in real time and detects fraud. Merchants should get alerts when a payment looks suspicious.';

test('started implementation -> request a change -> impact review -> approve -> V2 -> compare -> review plan migration', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(`e2e-chg-${Date.now()}@example.com`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill('Change e2e');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Your idea').fill(PITCH);
  await page.getByRole('button', { name: 'Analyze my idea' }).click();
  await page.getByRole('link', { name: 'Continue to Discovery' }).click();
  for (const round of [1, 2]) {
    await expect(page.getByRole('heading', { name: `Round ${round}` })).toBeVisible({ timeout: 30_000 });
    const cards = page.getByTestId('question-card');
    for (let i = 0; i < await cards.count(); i++) await cards.nth(i).getByRole('radio').first().check();
    await page.getByRole('button', { name: 'Submit answers' }).click();
  }
  await page.getByRole('button', { name: 'Generate Architecture Brief' }).click({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Confirm requirements' }).click({ timeout: 30_000 });
  await page.getByRole('link', { name: 'Generate the architecture' }).click();
  await page.getByRole('button', { name: 'Generate architecture' }).click();
  await expect(page.getByTestId('architecture-canvas')).toBeVisible({ timeout: 90_000 });

  // Click a component on the canvas, open its implementation workspace.
  await page.getByTestId('node-event-stream').click();
  await page.getByTestId('open-implementation').click();
  await expect(page.getByTestId('component-title')).toHaveText('Event stream');
  await page.getByRole('link', { name: 'Implementation' }).first().click();
  await page.getByRole('button', { name: 'Generate implementation plan' }).click();
  await expect(page.getByTestId('implementation-progress')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('impl-progress')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('next-task')).toContainText('Recommended next step');

  // Complete the first task honestly, so there is real progress at stake.
  await page.getByTestId('next-task').getByRole('link', { name: 'Open task' }).click();
  await page.getByRole('button', { name: 'Start task' }).click();
  // Server-confirmed checkboxes only change after the API answers, so click and wait for the confirmed state (check() expects an immediate change).
  for (const box of await page.getByTestId('validation-check').all()) { await box.click(); await expect(box).toBeChecked(); }
  await page.getByTestId('complete-task').click();
  await expect(page.getByTestId('completed-note')).toContainText('confirmed by you');

  // Request a change: a PROPOSAL, nothing changes yet.
  await page.getByRole('link', { name: 'Change Requests' }).click();
  await page.getByTestId('new-change').click();
  await page.getByTestId('change-text').fill('Replace Managed event streaming with Amazon Kinesis');
  await page.getByTestId('submit-change').click();
  await expect(page.getByTestId('impact-summary')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('proposal-status')).toHaveText('Ready for review');
  await expect(page.getByTestId('affected-nodes')).toContainText('event-stream');

  // Approve explicitly; the worker creates V2 and keeps V1.
  await page.getByTestId('approve').click();
  await expect(page.getByTestId('applied')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('applied')).toContainText('V1 is preserved as superseded');

  // Compare: labels and icons, not only colour.
  await page.getByTestId('view-diff').click();
  await expect(page.getByTestId('compare-title')).toHaveText('Architecture V1 → V2');
  await expect(page.getByTestId('diff-summary')).toContainText('1 component replaced');
  await expect(page.getByTestId('diff-event-stream')).toContainText('Replaced');

  // The new plan waits for the user's review of how progress carries over.
  await page.getByRole('link', { name: 'Implementation' }).first().click();
  await expect(page.getByTestId('pending-migration')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('pending-migration').getByRole('link').click();
  await expect(page.getByTestId('migration-summary')).toBeVisible();
  await page.getByTestId('accept-migration').click();
  await expect(page.getByText('Migration accepted')).toBeVisible();
});
