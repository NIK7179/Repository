import { expect, test } from '@playwright/test';

const PITCH = 'I want to create a platform that processes millions of transaction events in real time and detects fraud. Merchants should get alerts when a payment looks suspicious.';

test('sign in, create a project, submit an idea and see the interpretation', async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;
  const projectName = `Fraud platform ${Date.now()}`;

  await page.goto('/projects');
  await expect(page).toHaveURL(/\/sign-in/); // unauthenticated users are redirected

  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByText('No projects yet')).toBeVisible();

  await page.getByRole('link', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill('x');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#name-error')).toContainText('at least 2 characters'); // getByRole('alert') also matches Next's route announcer
  await page.getByLabel('Project name').fill(projectName);
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByLabel('Your idea').fill('too short');
  await page.getByRole('button', { name: 'Analyze my idea' }).click();
  await expect(page.locator('#pitch-error')).toContainText('at least 20 characters');

  await page.getByLabel('Your idea').fill(PITCH);
  await page.getByRole('button', { name: 'Analyze my idea' }).click();

  await expect(page.getByRole('heading', { name: 'Here is what we understood' })).toBeVisible();
  const view = page.getByTestId('interpretation');
  await expect(view).toContainText('What you told us');
  await expect(view).toContainText('We inferred');
  await expect(view).toContainText('Things we still need to understand');

  await page.getByRole('link', { name: 'Continue to Discovery' }).click();
  await expect(page.getByRole('heading', { name: 'Round 1' })).toBeVisible({ timeout: 30_000 }); // discovery (Phase 2) replaced the Phase 1 placeholder

  await page.goto('/projects');
  await expect(page.getByTestId('project-list')).toContainText(projectName);
  await page.getByRole('link', { name: 'Continue' }).click();
  await expect(page.getByTestId('project-name')).toHaveText(projectName);
  await expect(page.getByTestId('pitch-text')).toHaveText(PITCH); // the original pitch is preserved verbatim
});

test("one user cannot open another user's project", async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  await a.goto('/sign-in');
  await a.getByLabel('Email').fill(`owner-${Date.now()}@example.com`);
  await a.getByRole('button', { name: 'Sign in', exact: true }).click();
  await a.getByRole('link', { name: 'Create your first project' }).click();
  await a.getByLabel('Project name').fill('Private project');
  await a.getByRole('button', { name: 'Continue' }).click();
  await a.getByLabel('Your idea').fill(PITCH);
  await a.getByRole('button', { name: 'Analyze my idea' }).click();
  await a.getByRole('link', { name: 'View project' }).click();
  await a.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  const url = a.url();

  const b = await (await browser.newContext()).newPage();
  await b.goto('/sign-in');
  await b.getByLabel('Email').fill(`intruder-${Date.now()}@example.com`);
  await b.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(b).toHaveURL(/\/projects$/); // let the sign-in redirect finish before navigating
  await b.goto(url);
  await expect(b.getByText('Project not found', { exact: true })).toBeVisible();
  await expect(b.getByText('Private project')).toHaveCount(0); // nothing of the owner's project leaks
});
