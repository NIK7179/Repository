import { expect, test } from '@playwright/test';

const PITCH = 'I want to create a platform that processes millions of transaction events in real time and detects fraud. Merchants should get alerts when a payment looks suspicious.';

test('pitch an idea, answer discovery, review the brief and confirm requirements', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(`e2e-discovery-${Date.now()}@example.com`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill('Fraud discovery');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Your idea').fill(PITCH);
  await page.getByRole('button', { name: 'Analyze my idea' }).click();
  await page.getByRole('link', { name: 'Continue to Discovery' }).click();

  await expect(page.getByRole('heading', { name: 'Round 1' })).toBeVisible({ timeout: 30_000 });
  const cards = page.getByTestId('question-card');
  const first = await cards.count();
  expect(first).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < first; i++) {
    if (i === 2) await cards.nth(i).getByRole('checkbox', { name: /recommend for me/i }).check();
    else await cards.nth(i).getByRole('radio').first().check();
  }
  await page.getByRole('button', { name: 'Submit answers' }).click();
  await expect(page.getByRole('heading', { name: 'Round 2' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('We recommended').first()).toBeVisible();

  const second = page.getByTestId('question-card');
  for (let i = 0; i < await second.count(); i++) await second.nth(i).getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Submit answers' }).click();
  await page.getByRole('button', { name: 'Generate Architecture Brief' }).click({ timeout: 30_000 });

  await expect(page).toHaveURL(/\/brief$/, { timeout: 30_000 });
  await expect(page.getByTestId('brief-summary')).toBeVisible();
  await expect(page.getByTestId('brief-drivers')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm requirements' }).click();
  await expect(page.getByText('Requirements confirmed')).toBeVisible({ timeout: 30_000 });
});
