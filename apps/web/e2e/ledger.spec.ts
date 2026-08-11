import { expect, test } from '@playwright/test';

/**
 * Register, create a book, create two accounts, post a balanced entry, see it in the tree and
 * in the trial balance, reverse it, and watch the balances return.
 *
 * A fresh email per run, because this database is not reset between runs and a ledger cannot
 * delete anything - which is the point of the system, and makes a unique fixture the only
 * isolation available.
 */
const email = () => `e2e-${String(Date.now())}@example.com`;
const PASSWORD = 'a-long-enough-password';

test('a book, an entry, and its reversal', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel(/email/i).fill(email());
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole('button', { name: /create account/i }).click();

  await page.getByLabel(/name/i).fill('E2E book');
  await page.getByLabel(/currency/i).fill('EUR');
  await page.getByRole('button', { name: /create book/i }).click();

  await page.getByRole('link', { name: 'E2E book' }).click();

  for (const [name, type] of [['Cash', 'asset'], ['Sales', 'revenue']] as const) {
    await page.getByLabel(/^name$/i).fill(name);
    await page.getByLabel(/type/i).selectOption(type);
    await page.getByLabel(/currency/i).fill('EUR');
    await page.getByRole('button', { name: /create account/i }).click();
    await expect(page.getByRole('link', { name })).toBeVisible();
  }

  // The reload is the assertion here: the access token is held in memory only, so surviving
  // this proves the refresh cookie reached /auth/refresh through the proxy.
  await page.reload();
  await expect(page.getByRole('link', { name: 'Cash' })).toBeVisible();

  // Captured before navigating away from the tree, so the trip back doesn't depend on
  // `page.url()` still pointing where this test last left it.
  const treeUrl = page.url();

  await page.goto(new URL(treeUrl).pathname.replace('/accounts', '/entries/new'));
  await page.getByLabel(/description/i).fill('a sale');

  const rows = page.getByRole('row');
  await rows.nth(1).getByLabel(/account/i).selectOption({ label: 'Cash (EUR)' });
  await rows.nth(1).getByLabel(/debit/i).fill('10.00');
  await rows.nth(2).getByLabel(/account/i).selectOption({ label: 'Sales (EUR)' });
  await rows.nth(2).getByLabel(/credit/i).fill('10.00');

  await expect(page.getByText(/balanced/i)).toBeVisible();
  await page.getByRole('button', { name: /post entry/i }).click();
  await expect(page.getByText(/entry recorded/i)).toBeVisible();

  // Back to the tree: the posting already moved Cash's balance.
  await page.goto(new URL(treeUrl).pathname);
  const cashTreeRow = page.locator('li').filter({ hasText: 'Cash' }).first();
  await expect(cashTreeRow).toContainText('10.00');

  // Follow Cash to its own detail screen, then the posting's description to the reversal -
  // the same path a caller in the real app takes, not a direct visit to the reverse URL.
  await page.getByRole('link', { name: 'Cash', exact: true }).click();
  await expect(page.getByText(/balance:/i)).toContainText('10.00');

  await page.getByRole('link', { name: 'a sale' }).click();

  // The preview's arithmetic is certain even though the outcome is not: one row per account
  // the entry touched, before/change/after. Cash's change is the negation of what was posted.
  // The row is located by the account name the preview renders, not the UUID underneath it -
  // the screen joins postings against the book's accounts precisely so a caller never has to
  // read a UUID off this page.
  await expect(page.getByRole('row')).toHaveCount(3); // header + Cash + Sales
  const cashReversalRow = page.getByRole('row').filter({ hasText: 'Cash' });
  await expect(cashReversalRow.getByRole('cell').nth(1)).toHaveText('10.00'); // before
  await expect(cashReversalRow.getByRole('cell').nth(2)).toHaveText('-10.00'); // change
  await expect(cashReversalRow.getByRole('cell').nth(3)).toHaveText('0.00'); // after

  await page.getByRole('button', { name: /reverse this entry/i }).click();
  await expect(page.getByText(/entry reversed/i)).toBeVisible();

  // The property worth having: a reversal leaves the book exactly as balanced as it found it.
  // Cash is back to zero, and the report carries no "does not balance" alert.
  await page.goto(new URL(treeUrl).pathname.replace('/accounts', '/trial-balance'));
  await expect(page.getByText(/does not balance/i)).toHaveCount(0);
  const cashBalanceRow = page.locator('tr').filter({ hasText: 'Cash' }).first();
  await expect(cashBalanceRow).toContainText('0.00');
});
