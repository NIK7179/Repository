import { expect, test } from '@playwright/test';

const PITCH = 'I want to create a platform that processes millions of transaction events in real time and detects fraud. Merchants should get alerts when a payment looks suspicious.';

test('architecture ready -> implementation plan -> open a component -> do a task -> ask the architect', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(`e2e-impl-${Date.now()}@example.com`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill('Implementation e2e');
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

  // Do the first task honestly: start, confirm the checks yourself, complete.
  await page.getByTestId('next-task').getByRole('link', { name: 'Open task' }).click();
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.getByTestId('task-status')).toHaveText('In progress');
  for (const box of await page.getByTestId('validation-check').all()) await box.check();
  await page.getByTestId('complete-task').click();
  await expect(page.getByTestId('completed-note')).toContainText('confirmed by you');

  // Ask the architect from the task; the answer streams in and knows the project.
  await page.getByTestId('ask-input').fill('Why do I need this?');
  await page.getByTestId('ask-send').click();
  await expect(page.getByTestId('assistant-message').first()).toBeVisible({ timeout: 60_000 });
});
