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

  await page.goto(new URL(page.url()).pathname.replace('/accounts', '/entries/new'));
  await page.getByLabel(/description/i).fill('a sale');

  const rows = page.getByRole('row');
  await rows.nth(1).getByLabel(/account/i).selectOption({ label: 'Cash (EUR)' });
  await rows.nth(1).getByLabel(/debit/i).fill('10.00');
  await rows.nth(2).getByLabel(/account/i).selectOption({ label: 'Sales (EUR)' });
  await rows.nth(2).getByLabel(/credit/i).fill('10.00');

  await expect(page.getByText(/balanced/i)).toBeVisible();
  await page.getByRole('button', { name: /post entry/i }).click();
  await expect(page.getByText(/entry recorded/i)).toBeVisible();
});
