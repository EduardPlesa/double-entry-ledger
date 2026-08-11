import { useQuery } from '@tanstack/react-query';
import type { AccountResource } from '@ledger/shared';
import { apiFetch } from '../api/client';
import { keys } from '../api/keys';

/**
 * Every account in a book, in one request.
 *
 * One query, not one per account: the API returns the whole book's accounts ordered by type
 * then name, and the tree, the composer's account picker and the reversal preview all read
 * from this same cache entry rather than each fetching their own.
 */
export function useAccounts(bookId: string) {
  return useQuery({
    queryKey: keys.accounts(bookId),
    queryFn: () => apiFetch<AccountResource[]>(`/books/${bookId}/accounts`),
  });
}
