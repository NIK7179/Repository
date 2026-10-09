import { expect, test } from '@playwright/test';

// NOT RUN in the build environment (no Playwright browser download). Written against the same test ids the real-server UI tests exercise.
const PITCH = 'I want to create a platform that processes millions of transaction events in real time and detects fraud. Merchants should get alerts when a payment looks suspicious.';

test('component documentation and a grounded answer with a citation the user can inspect', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(`e2e-know-${Date.now()}@example.com`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Create your first project' }).click();
  await page.getByLabel('Project name').fill('Knowledge e2e');
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
  await page.getByTestId('node-primary-database').click();
  await page.getByTestId('open-implementation').click();
  await expect(page.getByTestId('component-title')).toHaveText('Primary database');

  // Documentation tab: official documents, then a search.
  await page.getByRole('tab', { name: 'Documentation' }).click();
  await expect(page.getByTestId('docs-list')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('doc-search-input').fill('How do I require TLS for remote clients?');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByTestId('doc-search-results')).toContainText('remote clients', { timeout: 30_000 });

  // Ask the architect: the answer is grounded, the chip opens the source inspector with a link to the vendor's site.
  await page.getByRole('tab', { name: 'Ask Architect' }).click();
  await page.getByTestId('ask-input').fill('How do I require TLS for remote clients?');
  await page.getByTestId('ask-send').click();
  const msg = page.getByTestId('assistant-message').first();
  await expect(msg.getByTestId('grounding-status')).toHaveAttribute('data-status', 'GROUNDED', { timeout: 60_000 });
  await msg.getByTestId('citation-chip').first().click();
  const inspector = msg.getByTestId('source-inspector');
  await expect(inspector.getByTestId('source-link')).toHaveAttribute('href', /^https:\/\/www\.postgresql\.org\//);
  await expect(inspector.getByTestId('source-link')).toHaveAttribute('rel', 'noopener noreferrer');
});
