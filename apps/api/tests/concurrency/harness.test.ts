import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { LedgerService } from '../../src/services/ledger.service.js';
import { fundedBook } from '../helpers/concurrency.js';
import { balanceOf } from '../helpers/ledger.js';
import { createService } from '../helpers/service.js';

let pool: Pool;
let service: LedgerService;

beforeAll(() => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 20 });
  service = createService(pool).service;
});

afterAll(async () => {
  await pool.end();
});

describe('the concurrency harness', () => {
  it('funds a book to a known balance', async () => {
    const book = await fundedBook(pool, service, 50_000n);

    expect(await balanceOf(pool, book.bookId, book.cash)).toBe(50_000n);
  });
});
