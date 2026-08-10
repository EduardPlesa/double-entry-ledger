/**
 * Every query key in the application, built here.
 *
 * Keys are what invalidation targets, so a key spelled inline at the call site is an
 * invalidation nobody can grep for. Each is a function even where it takes no argument, so
 * every call site reads the same way.
 */
export const keys = {
  books: () => ['books'] as const,
  accounts: (bookId: string) => ['book', bookId, 'accounts'] as const,
  trialBalance: (bookId: string, asOf: string | null) =>
    ['book', bookId, 'trial-balance', asOf] as const,
  balance: (accountId: string, asOf: string | null) =>
    ['account', accountId, 'balance', asOf] as const,
  postings: (accountId: string) => ['account', accountId, 'postings'] as const,
  entry: (entryId: string) => ['entry', entryId] as const,
};
