import { expect, test } from '@playwright/test';

const PITCH = 'I want to create a platform that processes millions of transaction events in real time and detects fraud. Merchants should get alerts when a payment looks suspicious.';

test('confirmed requirements -> generate architecture -> explore the canvas -> see why a component exists', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(`e2e-arch-${Date.now()}@example.com`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill('Architecture e2e');
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
  await expect(page.getByText('Requirements confirmed')).toBeVisible({ timeout: 30_000 });

  await page.getByRole('link', { name: 'Generate the architecture' }).click();
  await page.getByRole('button', { name: 'Generate architecture' }).click();
  await expect(page.getByTestId('generation-progress')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('architecture-canvas')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('architecture-summary')).toContainText('Version 1');

  await page.getByTestId('node-event-stream').click();
  await expect(page.getByTestId('node-inspector')).toBeVisible();
  await expect(page.getByTestId('why-summary')).toContainText('is here because');
  await page.getByRole('tab', { name: 'Data flow' }).click();
  await page.getByRole('link', { name: 'Decisions' }).click();
  await expect(page.getByTestId('decision-card').first()).toContainText('ADR-001');
});
