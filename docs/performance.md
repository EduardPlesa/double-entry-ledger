# Performance

500,000 postings, five reads, `EXPLAIN (ANALYZE, BUFFERS)` either side of one migration. One
finding is the headline win the checkpoint design exists to produce. One is a regression this
migration does not fix and ships anyway, with the reason why. One index was measured and
dropped.

## What was measured, and on what

Postgres **16.14**, in a container (`postgres:16-alpine`, `docker-compose.yml`, port 5433 on the
host mapped to 5432 in the container), not a bare-metal install.

Host: Windows 11, Docker Desktop. The container's Docker Desktop VM reports 16 CPUs and
8,228,859,904 bytes (~7.7 GiB) of RAM.

Every setting relevant to these plans is the Postgres 16 default — none of `shared_buffers`,
`work_mem`, or `random_page_cost` is overridden anywhere in `docker-compose.yml` or
`docker/initdb/`:

| Setting | Value |
|---|---|
| `shared_buffers` | `128MB` |
| `work_mem` | `4MB` |
| `random_page_cost` | `4` |

That last one matters more than a routine default: it is the direct cause of the `lowest-prefix`
regression below, and it stays at its default because nothing in this task's scope changes a
database-wide cost constant.

## The corpus

Every constant is in [`apps/api/scripts/seed-perf.ts`](../apps/api/scripts/seed-perf.ts):

| Constant | Value |
|---|---|
| `POSTINGS` | `500_000` (two legs per entry, so 250,000 entries) |
| `ASSET_ACCOUNTS` | `100` |
| `REVENUE_ACCOUNTS` | `100` |
| `START` | `2023-01-01T00:00:00Z` |
| `SPAN_DAYS` | `1095` (three years) |
| `BACKDATED_EVERY` | `10` (one entry in ten occurs before its predecessor) |
| `BACKDATE_MAX_DAYS` | `180` |
| `RNG_SEED` | `0.42` (`SELECT setseed(0.42)`, before the one statement that consumes `random()`) |
| `CURRENCY` | `EUR` |

Build it:

```bash
pnpm --filter @ledger/api perf:seed
```

A full run took, on this machine: `accounts` 46ms, `entries` 7,973ms, `postings` 25,633ms,
`analyze` 148ms — about 33.8 seconds end to end. The postings phase dominates; it is the
three-way-joined, window-functioned, `UNION ALL`-doubled statement that assigns both legs of
every entry in one pass.

**No skew.** Each entry's asset leg is assigned by `n % ASSET_ACCOUNTS` — a plain round-robin
over a range with no remainder — so all 100 asset accounts receive exactly 2,500 postings each.
There is no busiest account. Every plan below was taken against one account chosen
deterministically from that tied set (the harness breaks the tie with `account_id asc` so
baseline and indexed runs pick the same one); it is a representative account, not a worst case,
and nothing in this document should be read as if it measured one.

**Verification is database-wide, not book-scoped.** `seed-perf.ts`'s three verification
queries — unbalanced entries, entries with no legs, accounts that ever went negative — check
`entries`/`postings` with no `WHERE book_id = ...`, on purpose: the triggers they stand in for
are global too. That means running the seed against a database that already holds an older run,
a half-finished load, or unrelated test data folds that data into the count and can fail a load
that was itself fine. Start from a database with nothing else of the same shape in it:

```bash
pnpm db:nuke && pnpm db:up && pnpm db:migrate
```

## How the plans were taken

Every plan below was captured by
[`apps/api/scripts/explain.ts`](../apps/api/scripts/explain.ts), connected as `ledger_app` (not
the schema owner), inside a transaction with `app.current_book_id` set the same way
`db/client.ts`'s `transactionInBook` sets it. That means the row-level security predicate from
migration `0006` — `book_id = (NULLIF(current_setting('app.current_book_id', true), ''))::uuid`
— is part of every plan below, because it is part of every plan the application actually pays
for. A plan captured as the table owner would not include it and would not describe production.

Each statement ran three times on the same connection; only the third (warm) run is reported.
The first run measures the page cache as much as the query. Captured with
`EXPLAIN (ANALYZE, BUFFERS, VERBOSE false, FORMAT TEXT)`.

Book `6338abfa-7f72-4bd7-a03e-b57e27e5051f`, account `047086dd-749b-455c-be99-5126194a02e9`
(2,500 postings), the same account in every baseline and indexed capture below.

## balance-from-zero

The naive account sum — `sumPostings` with no `asOf`. Still the only answer for an account with
no checkpoint.

```sql
select coalesce(sum("postings"."amount_minor"), 0)::text from "postings" inner join "entries" on "entries"."id" = "postings"."entry_id" where "postings"."account_id" = $1
```

**Baseline**

```text
Finalize Aggregate  (cost=15422.19..15422.21 rows=1 width=32) (actual time=16.456..20.747 rows=1 loops=1)
  Buffers: shared hit=13678
  ->  Gather  (cost=15421.97..15422.18 rows=2 width=32) (actual time=16.281..20.733 rows=3 loops=1)
        Workers Planned: 2
        Workers Launched: 2
        Buffers: shared hit=13678
        ->  Partial Aggregate  (cost=14421.97..14421.98 rows=1 width=32) (actual time=11.717..11.719 rows=1 loops=3)
              Buffers: shared hit=13678
              ->  Nested Loop  (cost=0.43..14419.38 rows=1035 width=8) (actual time=0.077..11.652 rows=833 loops=3)
                    Buffers: shared hit=13678
                    ->  Parallel Seq Scan on postings  (cost=0.00..11381.33 rows=1035 width=24) (actual time=0.029..8.436 rows=833 loops=3)
                          Filter: ((account_id = '047086dd-749b-455c-be99-5126194a02e9'::uuid) AND (book_id = (NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid))
                          Rows Removed by Filter: 165833
                          Buffers: shared hit=6173
                    ->  Index Only Scan using entries_id_book_id_key on entries  (cost=0.43..2.94 rows=1 width=16) (actual time=0.003..0.003 rows=1 loops=2500)
                          Index Cond: ((id = postings.entry_id) AND (book_id = (NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid))
                          Heap Fetches: 0
                          Buffers: shared hit=7505
Planning:
  Buffers: shared hit=9
Planning Time: 0.285 ms
Execution Time: 20.826 ms
```

**Indexed**

```text
Finalize Aggregate  (cost=10112.10..10112.12 rows=1 width=32) (actual time=9.518..14.784 rows=1 loops=1)
  Buffers: shared hit=10018
  ->  Gather  (cost=10111.99..10112.10 rows=1 width=32) (actual time=9.316..14.773 rows=2 loops=1)
        Workers Planned: 1
        Workers Launched: 1
        Buffers: shared hit=10018
        ->  Partial Aggregate  (cost=9111.99..9112.00 rows=1 width=32) (actual time=6.564..6.566 rows=1 loops=2)
              Buffers: shared hit=10018
              ->  Nested Loop  (cost=72.21..9108.31 rows=1469 width=8) (actual time=0.533..6.486 rows=1250 loops=2)
                    Buffers: shared hit=10018
                    ->  Parallel Bitmap Heap Scan on postings  (cost=71.78..4803.58 rows=1469 width=24) (actual time=0.487..2.638 rows=1250 loops=2)
                          Recheck Cond: (account_id = '047086dd-749b-455c-be99-5126194a02e9'::uuid)
                          Filter: (book_id = (NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid)
                          Heap Blocks: exact=2044
                          Buffers: shared hit=2515
                          ->  Bitmap Index Scan on postings_account_id_id_idx  (cost=0.00..71.16 rows=2498 width=0) (actual time=0.688..0.688 rows=2500 loops=1)
                                Index Cond: (account_id = '047086dd-749b-455c-be99-5126194a02e9'::uuid)
                                Buffers: shared hit=15
                    ->  Index Only Scan using entries_id_book_id_key on entries  (cost=0.43..2.93 rows=1 width=16) (actual time=0.002..0.002 rows=1 loops=2500)
                          Index Cond: ((id = postings.entry_id) AND (book_id = (NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid))
                          Heap Fetches: 0
                          Buffers: shared hit=7503
Planning:
  Buffers: shared hit=17
Planning Time: 0.350 ms
Execution Time: 14.889 ms
```

**Reading it.** The planner replaces the `Parallel Seq Scan on postings` (6,173 buffers, 165,833
rows filtered out per worker) with a `Bitmap Index Scan` on `postings_account_id_id_idx` feeding
a `Parallel Bitmap Heap Scan` (2,515 buffers) — the account-filtered side of the query drops from
scanning the whole table to reading only the account's own 2,500 rows. Total buffers fall 13,678
→ 10,018 (−27%) and execution time 20.826 ms → 14.889 ms (−29%). The join to `entries`
(`Index Only Scan using entries_id_book_id_key`, 7,505 buffers baseline / 7,503 indexed) is
untouched by this index and dominates neither side.

**An optimization candidate this measurement found, not fixed here.** That join to `entries` is
unconditional in `sumPostings` even though `asOf` is unset on this path and no `entries` column
is ever read from the result — the join exists only because the repository method always emits
it. It accounts for 7,505 of the baseline's 13,678 buffer hits, and 7,503 of the indexed plan's
10,018 — over half the cost of this query, in both modes, spent on a table the query result never
touches. An `asOf`-conditional join (only join `entries` when a cutoff date is actually being
applied) is the natural fix; it is not made here because this task is about indexes, not
repository rewrites.

## balance-from-checkpoint

Two statements under one heading, because the read `getBalance` performs is two: the checkpoint
lookup, then the delta sum for everything after its watermark.

### Checkpoint lookup

```sql
select "account_id", "through_id", "balance_minor", "computed_at" from "balance_checkpoints" where "balance_checkpoints"."account_id" = $1 order by "balance_checkpoints"."through_id" desc limit $2
```

**Baseline**

```text
Limit  (cost=8.01..8.02 rows=1 width=40) (actual time=0.030..0.030 rows=1 loops=1)
  Buffers: shared hit=3
  ->  Sort  (cost=8.01..8.02 rows=1 width=40) (actual time=0.029..0.030 rows=1 loops=1)
        Sort Key: through_id DESC
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=3
        ->  Seq Scan on balance_checkpoints  (cost=0.00..8.00 rows=1 width=40) (actual time=0.009..0.015 rows=1 loops=1)
              Filter: ((account_id = '047086dd-749b-455c-be99-5126194a02e9'::uuid) AND (book_id = (NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid))
              Rows Removed by Filter: 199
              Buffers: shared hit=3
Planning Time: 0.049 ms
Execution Time: 0.049 ms
```

**Indexed**

```text
Limit  (cost=8.01..8.02 rows=1 width=40) (actual time=0.031..0.031 rows=1 loops=1)
  Buffers: shared hit=3
  ->  Sort  (cost=8.01..8.02 rows=1 width=40) (actual time=0.030..0.030 rows=1 loops=1)
        Sort Key: through_id DESC
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=3
        ->  Seq Scan on balance_checkpoints  (cost=0.00..8.00 rows=1 width=40) (actual time=0.013..0.020 rows=1 loops=1)
              Filter: ((account_id = '047086dd-749b-455c-be99-5126194a02e9'::uuid) AND (book_id = (NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid))
              Rows Removed by Filter: 199
              Buffers: shared hit=3
Planning Time: 0.098 ms
Execution Time: 0.058 ms
```

**Reading it.** Identical plan shape, identical buffers (3, both sides) — expected, since this
migration's index is on `postings`, and this statement never touches that table. The 0.049 ms →
0.058 ms difference is run-to-run noise on a sub-millisecond `Seq Scan` of a 200-row table, not a
regression.

### Delta sum

```sql
select coalesce(sum("amount_minor"), 0)::text from "postings" where ("postings"."account_id" = $1 and "postings"."id" > $2)
```

**Baseline**

```text
Finalize Aggregate  (cost=11316.98..11317.00 rows=1 width=32) (actual time=12.250..15.061 rows=1 loops=1)
  Buffers: shared hit=4247
  ->  Gather  (cost=11316.76..11316.97 rows=2 width=32) (actual time=12.126..15.053 rows=3 loops=1)
        Workers Planned: 2
        Workers Launched: 2
        Buffers: shared hit=4247
        ->  Partial Aggregate  (cost=10316.76..10316.77 rows=1 width=32) (actual time=8.444..8.445 rows=1 loops=3)
              Buffers: shared hit=4247
              ->  Parallel Index Scan using postings_pkey on postings  (cost=0.42..10315.46 rows=518 width=8) (actual time=8.441..8.441 rows=0 loops=3)
                    Index Cond: (id > '250000'::bigint)
                    Filter: ((account_id = '047086dd-749b-455c-be99-5126194a02e9'::uuid) AND (book_id = (NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid))
                    Rows Removed by Filter: 83333
                    Buffers: shared hit=4247
Planning Time: 0.129 ms
Execution Time: 15.113 ms
```

**Indexed**

```text
Aggregate  (cost=3171.34..3171.35 rows=1 width=32) (actual time=0.006..0.006 rows=1 loops=1)
  Buffers: shared hit=3
  ->  Bitmap Heap Scan on postings  (cost=41.30..3168.20 rows=1256 width=8) (actual time=0.004..0.005 rows=0 loops=1)
        Recheck Cond: ((account_id = '047086dd-749b-455c-be99-5126194a02e9'::uuid) AND (id > '250000'::bigint))
        Filter: (book_id = (NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid)
        Buffers: shared hit=3
        ->  Bitmap Index Scan on postings_account_id_id_idx  (cost=0.00..40.98 rows=1256 width=0) (actual time=0.004..0.004 rows=0 loops=1)
              Index Cond: ((account_id = '047086dd-749b-455c-be99-5126194a02e9'::uuid) AND (id > '250000'::bigint))
              Buffers: shared hit=3
Planning Time: 0.055 ms
Execution Time: 0.045 ms
```

**Reading it — the headline win.** Before this index, the delta sum is a `Parallel Index Scan
using postings_pkey` filtered by `account_id` after the fact: it walks every posting with
`id > watermark` — 83,333 rows removed by the filter — costing 4,247 buffers and 15.113 ms. With
`postings_account_id_id_idx`, `(account_id, id)` is a single index condition, not a scan-then-filter:
the plan becomes a two-page `Bitmap Index Scan` (3 buffers) and the query finishes in 0.045 ms.
4,247 buffers → 3 buffers, 15.113 ms → 0.045 ms — about 336× faster on wall clock and roughly
1,416× fewer buffers. This is the read plan 1's whole checkpoint design exists to make cheap, and
it is now a two-page index probe rather than a scan of half a million rows.

## lowest-prefix

The overdraft scan, from `lowestPrefixBalance` verbatim — it runs inside the entry-insert
critical section with the account's row lock held, and again in the deferred trigger at COMMIT.

```sql
select running::text as balance, occurred_at
from (
  select
    sum("postings"."amount_minor") over (
      order by "entries"."occurred_at", "postings"."id"
      rows between unbounded preceding and current row
    ) as running,
    "entries"."occurred_at" as occurred_at
  from "postings"
  join "entries" on "entries"."id" = "postings"."entry_id"
  where "postings"."account_id" = $1
) prefixes
order by running asc, occurred_at asc
limit 1
```

**Baseline**

```text
Limit  (cost=18244.54..18244.55 rows=1 width=72) (actual time=18.377..21.211 rows=1 loops=1)
  Buffers: shared hit=16207
  ->  Sort  (cost=18244.54..18250.76 rows=2485 width=72) (actual time=18.375..21.209 rows=1 loops=1)
        Sort Key: prefixes.running, prefixes.occurred_at
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=16207
        ->  Subquery Scan on prefixes  (cost=17861.94..18232.12 rows=2485 width=72) (actual time=16.681..20.811 rows=2500 loops=1)
              Buffers: shared hit=16207
              ->  WindowAgg  (cost=17861.94..18194.84 rows=2485 width=48) (actual time=16.677..20.546 rows=2500 loops=1)
                    Buffers: shared hit=16207
                    ->  Gather Merge  (cost=17861.94..18151.36 rows=2485 width=24) (actual time=16.641..19.734 rows=2500 loops=1)
                          Workers Planned: 2
                          Workers Launched: 2
                          Buffers: shared hit=16207
                          ->  Sort  (cost=16861.92..16864.50 rows=1035 width=24) (actual time=12.589..12.617 rows=833 loops=3)
                                Sort Key: entries.occurred_at, postings.id
                                Sort Method: quicksort  Memory: 117kB
                                Buffers: shared hit=16207
                                Worker 0:  Sort Method: quicksort  Memory: 50kB
                                Worker 1:  Sort Method: quicksort  Memory: 48kB
                                ->  Nested Loop  (cost=0.42..16810.09 rows=1035 width=24) (actual time=0.064..12.375 rows=833 loops=3)
                                      Buffers: shared hit=16175
                                      ->  Parallel Seq Scan on postings  (cost=0.00..11381.33 rows=1035 width=32) (actual time=0.029..8.605 rows=833 loops=3)
                                            Filter: ((account_id = '047086dd-749b-455c-be99-5126194a02e9'::uuid) AND (book_id = (NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid))
                                            Rows Removed by Filter: 165833
                                            Buffers: shared hit=6173
                                      ->  Index Scan using entries_pkey on entries  (cost=0.42..5.25 rows=1 width=24) (actual time=0.004..0.004 rows=1 loops=2500)
                                            Index Cond: (id = postings.entry_id)
                                            Filter: (book_id = (NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid)
                                            Buffers: shared hit=10002
Planning:
  Buffers: shared hit=9
Planning Time: 0.274 ms
Execution Time: 21.352 ms
```

**Indexed (default planner settings)**

```text
Limit  (cost=12086.24..12086.24 rows=1 width=72) (actual time=54.766..57.566 rows=1 loops=1)
  Buffers: shared hit=5692
  ->  Sort  (cost=12086.24..12092.49 rows=2498 width=72) (actual time=54.765..57.564 rows=1 loops=1)
        Sort Key: prefixes.running, prefixes.occurred_at
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=5692
        ->  Subquery Scan on prefixes  (cost=11701.63..12073.75 rows=2498 width=72) (actual time=53.183..57.221 rows=2500 loops=1)
              Buffers: shared hit=5692
              ->  WindowAgg  (cost=11701.63..12036.28 rows=2498 width=48) (actual time=53.180..56.949 rows=2500 loops=1)
                    Buffers: shared hit=5692
                    ->  Gather Merge  (cost=11701.63..11992.57 rows=2498 width=24) (actual time=53.149..56.192 rows=2500 loops=1)
                          Workers Planned: 2
                          Workers Launched: 2
                          Buffers: shared hit=5692
                          ->  Sort  (cost=10701.61..10704.21 rows=1041 width=24) (actual time=48.891..48.925 rows=833 loops=3)
                                Sort Key: entries.occurred_at, postings.id
                                Sort Method: quicksort  Memory: 66kB
                                Buffers: shared hit=5692
                                Worker 0:  Sort Method: quicksort  Memory: 63kB
                                Worker 1:  Sort Method: quicksort  Memory: 62kB
                                ->  Parallel Hash Join  (cost=4821.94..10649.43 rows=1041 width=24) (actual time=1.667..48.586 rows=833 loops=3)
                                      Hash Cond: (entries.id = postings.entry_id)
                                      Buffers: shared hit=5660
                                      ->  Parallel Seq Scan on entries  (cost=0.00..5430.75 rows=104167 width=24) (actual time=0.021..41.018 rows=83333 loops=3)
                                            Filter: (book_id = (NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid)
                                            Buffers: shared hit=3087
                                      ->  Parallel Hash  (cost=4803.58..4803.58 rows=1469 width=32) (actual time=1.361..1.362 rows=833 loops=3)
                                            Buckets: 4096  Batches: 1  Memory Usage: 192kB
                                            Buffers: shared hit=2515
                                            ->  Parallel Bitmap Heap Scan on postings  (cost=71.78..4803.58 rows=1469 width=32) (actual time=0.521..3.731 rows=2500 loops=1)
                                                  Recheck Cond: (account_id = '047086dd-749b-455c-be99-5126194a02e9'::uuid)
                                                  Filter: (book_id = (NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid)
                                                  Heap Blocks: exact=2500
                                                  Buffers: shared hit=2515
                                                  ->  Bitmap Index Scan on postings_account_id_id_idx  (cost=0.00..71.16 rows=2498 width=0) (actual time=0.318..0.319 rows=2500 loops=1)
                                                        Index Cond: (account_id = '047086dd-749b-455c-be99-5126194a02e9'::uuid)
                                                        Buffers: shared hit=15
Planning:
  Buffers: shared hit=17
Planning Time: 0.397 ms
Execution Time: 57.764 ms
```

**Reading it — the honest headline problem.** The account-filtered side gets cheaper on both
plans' own terms: the `postings` scan drops from a `Parallel Seq Scan` (6,173 buffers) to a
`Parallel Bitmap Heap Scan` on `postings_account_id_id_idx` (2,515 buffers), and even the
`entries` side falls, 10,002 buffers baseline to 3,087 indexed. Total buffers fall 16,207 → 5,692
(−65%). But the planner uses the now-cheaper postings scan as the *build* side of a
`Parallel Hash Join` against a full `Parallel Seq Scan on entries` (83,333 rows per worker)
instead of the baseline's indexed `Nested Loop` into `entries_pkey` — and execution time rises,
21.352 ms → 57.764 ms, +171%. Buffers are not a safe proxy for cost on this query: the plan with
fewer buffers is the slower one.

**The forcing experiment.** Same query, same account, same book-scoped transaction, run as
`ledger_app` with `app.current_book_id` set the same way, three times, third kept, then
`ROLLBACK`.

`SET LOCAL enable_hashjoin = off`:

```text
Limit  (cost=13939.34..13939.34 rows=1 width=72) (actual time=13.436..16.414 rows=1 loops=1)
  Buffers: shared hit=12532
  ->  Sort  (cost=13939.34..13945.58 rows=2495 width=72) (actual time=13.434..16.412 rows=1 loops=1)
        Sort Key: prefixes.running, prefixes.occurred_at
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=12532
        ->  Subquery Scan on prefixes  (cost=13561.42..13926.86 rows=2495 width=72) (actual time=11.918..16.065 rows=2500 loops=1)
              Buffers: shared hit=12532
              ->  WindowAgg  (cost=13561.42..13889.44 rows=2495 width=48) (actual time=11.916..15.818 rows=2500 loops=1)
                    Buffers: shared hit=12532
                    ->  Gather Merge  (cost=13561.42..13845.78 rows=2495 width=24) (actual time=11.899..15.109 rows=2500 loops=1)
                          Workers Planned: 1
                          Workers Launched: 1
                          Buffers: shared hit=12532
                          ->  Sort  (cost=12561.41..12565.08 rows=1468 width=24) (actual time=8.915..8.954 rows=1250 loops=2)
                                Sort Key: entries.occurred_at, postings.id
                                Sort Method: quicksort  Memory: 142kB
                                Buffers: shared hit=12532
                                Worker 0:  Sort Method: quicksort  Memory: 48kB
                                ->  Nested Loop  (cost=72.18..12484.19 rows=1468 width=24) (actual time=0.518..8.619 rows=1250 loops=2)
                                      Buffers: shared hit=12516
                                      ->  Parallel Bitmap Heap Scan on postings  (cost=71.76..4800.73 rows=1468 width=32) (actual time=0.479..2.995 rows=1250 loops=2)
                                            Recheck Cond: (account_id = '047086dd-749b-455c-be99-5126194a02e9'::uuid)
                                            Filter: (book_id = (NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid)
                                            Heap Blocks: exact=2002
                                            Buffers: shared hit=2515
                                            ->  Bitmap Index Scan on postings_account_id_id_idx  (cost=0.00..71.14 rows=2495 width=0) (actual time=0.686..0.686 rows=2500 loops=1)
                                                  Index Cond: (account_id = '047086dd-749b-455c-be99-5126194a02e9'::uuid)
                                                  Buffers: shared hit=15
                                      ->  Index Scan using entries_pkey on entries  (cost=0.42..5.23 rows=1 width=24) (actual time=0.004..0.004 rows=1 loops=2500)
                                            Index Cond: (id = postings.entry_id)
                                            Filter: (book_id = (NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid)
                                            Buffers: shared hit=10001
Planning:
  Buffers: shared hit=9
Planning Time: 0.271 ms
Execution Time: 16.572 ms
```

`SET LOCAL random_page_cost = 1.1`, no forcing:

```text
Limit  (cost=6280.99..6280.99 rows=1 width=72) (actual time=13.573..16.969 rows=1 loops=1)
  Buffers: shared hit=12532
  ->  Sort  (cost=6280.99..6287.23 rows=2495 width=72) (actual time=13.572..16.967 rows=1 loops=1)
        Sort Key: prefixes.running, prefixes.occurred_at
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=12532
        ->  Subquery Scan on prefixes  (cost=5903.07..6268.52 rows=2495 width=72) (actual time=12.006..16.614 rows=2500 loops=1)
              Buffers: shared hit=12532
              ->  WindowAgg  (cost=5903.07..6231.09 rows=2495 width=48) (actual time=12.004..16.360 rows=2500 loops=1)
                    Buffers: shared hit=12532
                    ->  Gather Merge  (cost=5903.07..6187.43 rows=2495 width=24) (actual time=11.987..15.617 rows=2500 loops=1)
                          Workers Planned: 1
                          Workers Launched: 1
                          Buffers: shared hit=12532
                          ->  Sort  (cost=4903.06..4906.73 rows=1468 width=24) (actual time=9.202..9.242 rows=1250 loops=2)
                                Sort Key: entries.occurred_at, postings.id
                                Sort Method: quicksort  Memory: 137kB
                                Buffers: shared hit=12532
                                Worker 0:  Sort Method: quicksort  Memory: 53kB
                                ->  Nested Loop  (cost=34.48..4825.85 rows=1468 width=24) (actual time=0.553..8.860 rows=1250 loops=2)
                                      Buffers: shared hit=12516
                                      ->  Parallel Bitmap Heap Scan on postings  (cost=34.06..2233.96 rows=1468 width=32) (actual time=0.508..3.078 rows=1250 loops=2)
                                            Recheck Cond: (account_id = '047086dd-749b-455c-be99-5126194a02e9'::uuid)
                                            Filter: (book_id = (NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid)
                                            Heap Blocks: exact=1889
                                            Buffers: shared hit=2515
                                            ->  Bitmap Index Scan on postings_account_id_id_idx  (cost=0.00..33.44 rows=2495 width=0) (actual time=0.749..0.749 rows=2500 loops=1)
                                                  Index Cond: (account_id = '047086dd-749b-455c-be99-5126194a02e9'::uuid)
                                                  Buffers: shared hit=15
                                      ->  Index Scan using entries_pkey on entries  (cost=0.42..1.77 rows=1 width=24) (actual time=0.004..0.004 rows=1 loops=2500)
                                            Index Cond: (id = postings.entry_id)
                                            Filter: (book_id = (NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid)
                                            Buffers: shared hit=10001
Planning:
  Buffers: shared hit=9
Planning Time: 0.309 ms
Execution Time: 17.132 ms
```

**Ruling.** `SET LOCAL enable_hashjoin = off` forces the planner back onto a `Nested Loop` over
the same account-filtered index scan into `entries_pkey` — the same shape as baseline, just with
the cheaper indexed postings side — and it runs in 16.572 ms: *faster than baseline's 21.352 ms*,
at a higher buffer count (12,532) than the default indexed plan's losing hash join (5,692). That
rules out buffers as the explanation a second, independent way: the fastest plan here isn't the
lowest-buffer one either. Lowering `random_page_cost` to `1.1` — appropriate for a working set
that lives entirely in `shared_buffers`, as this corpus does — gets the planner to the same
nested-loop plan on its own, no forcing needed, at 17.132 ms.

So the index is exonerated. The cause is `random_page_cost`'s default of `4.0`, which assumes
non-cached, rotational-disk random I/O against a corpus whose working set is, for this session,
entirely resident in `shared_buffers`. That cost bias is what makes the hash join look cheaper
to the planner than the indexed nested loop, even though it measurably isn't.

**Neither setting ships.** Both are database-wide planner cost constants, and changing either is
a decision separate from an index migration. That means, plainly: **under today's default
configuration, `lowest-prefix` regresses** — 21.352 ms baseline to 57.764 ms indexed, a real cost
paid on every write to a guarded account, because this scan runs under the account's row lock in
the entry-insert critical section and again in the deferred trigger at COMMIT. The options, none
of them taken here:

- **Tune `random_page_cost`** (and possibly `effective_cache_size`) for a deployment whose
  working set is expected to stay cached — the forcing experiment shows this resolves it without
  touching the schema, at 17.132 ms, better than baseline.
- **Leave it and accept the write-path cost** — the index still wins on every other query it
  touches, and 57.764 ms under a row lock is a bounded, known cost rather than an unbounded one.
- **Revisit with a different index shape** that changes the planner's cost estimate for the join
  itself rather than only for the postings scan feeding it — not attempted here.

## trial-balance

The whole-book aggregate from `trialBalance`: every account in the book, LEFT JOINed to its
postings so an account with none still appears at zero.

```sql
select "accounts"."id", "accounts"."name", "accounts"."type", "accounts"."currency", coalesce(sum("postings"."amount_minor"), 0)::text from "accounts" left join "postings" on "postings"."account_id" = "accounts"."id" left join "entries" on "entries"."id" = "postings"."entry_id" where "accounts"."book_id" = $1 group by "accounts"."id", "accounts"."name", "accounts"."type", "accounts"."currency" order by "accounts"."type" asc, "accounts"."name" asc
```

**Baseline**

```text
Sort  (cost=21282.47..21282.97 rows=200 width=65) (actual time=374.349..374.358 rows=200 loops=1)
  Sort Key: accounts.type, accounts.name
  Sort Method: quicksort  Memory: 39kB
  Buffers: shared hit=6176
  ->  HashAggregate  (cost=21271.33..21274.83 rows=200 width=65) (actual time=374.190..374.236 rows=200 loops=1)
        Group Key: accounts.id
        Batches: 1  Memory Usage: 96kB
        Buffers: shared hit=6176
        ->  Result  (cost=8.01..18771.33 rows=500000 width=41) (actual time=0.069..325.765 rows=500000 loops=1)
              One-Time Filter: ((NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid = '6338abfa-7f72-4bd7-a03e-b57e27e5051f'::uuid)
              Buffers: shared hit=6176
              ->  Hash Right Join  (cost=8.01..18771.33 rows=500000 width=41) (actual time=0.066..294.512 rows=500000 loops=1)
                    Hash Cond: (postings.account_id = accounts.id)
                    Buffers: shared hit=6176
                    ->  Seq Scan on postings  (cost=0.00..17423.00 rows=500000 width=40) (actual time=0.004..222.178 rows=500000 loops=1)
                          Filter: (book_id = (NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid)
                          Buffers: shared hit=6173
                    ->  Hash  (cost=5.50..5.50 rows=200 width=33) (actual time=0.054..0.055 rows=200 loops=1)
                          Buckets: 1024  Batches: 1  Memory Usage: 22kB
                          Buffers: shared hit=3
                          ->  Seq Scan on accounts  (cost=0.00..5.50 rows=200 width=33) (actual time=0.006..0.024 rows=200 loops=1)
                                Filter: (book_id = '6338abfa-7f72-4bd7-a03e-b57e27e5051f'::uuid)
                                Buffers: shared hit=3
Planning:
  Buffers: shared hit=13
Planning Time: 0.266 ms
Execution Time: 374.505 ms
```

**Indexed**

```text
Sort  (cost=21282.47..21282.97 rows=200 width=65) (actual time=384.633..384.642 rows=200 loops=1)
  Sort Key: accounts.type, accounts.name
  Sort Method: quicksort  Memory: 39kB
  Buffers: shared hit=6176
  ->  HashAggregate  (cost=21271.33..21274.83 rows=200 width=65) (actual time=384.451..384.495 rows=200 loops=1)
        Group Key: accounts.id
        Batches: 1  Memory Usage: 96kB
        Buffers: shared hit=6176
        ->  Result  (cost=8.01..18771.33 rows=500000 width=41) (actual time=0.067..334.715 rows=500000 loops=1)
              One-Time Filter: ((NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid = '6338abfa-7f72-4bd7-a03e-b57e27e5051f'::uuid)
              Buffers: shared hit=6176
              ->  Hash Right Join  (cost=8.01..18771.33 rows=500000 width=41) (actual time=0.064..301.873 rows=500000 loops=1)
                    Hash Cond: (postings.account_id = accounts.id)
                    Buffers: shared hit=6176
                    ->  Seq Scan on postings  (cost=0.00..17423.00 rows=500000 width=40) (actual time=0.004..230.231 rows=500000 loops=1)
                          Filter: (book_id = (NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid)
                          Buffers: shared hit=6173
                    ->  Hash  (cost=5.50..5.50 rows=200 width=33) (actual time=0.053..0.054 rows=200 loops=1)
                          Buckets: 1024  Batches: 1  Memory Usage: 22kB
                          Buffers: shared hit=3
                          ->  Seq Scan on accounts  (cost=0.00..5.50 rows=200 width=33) (actual time=0.005..0.024 rows=200 loops=1)
                                Filter: (book_id = '6338abfa-7f72-4bd7-a03e-b57e27e5051f'::uuid)
                                Buffers: shared hit=3
Planning:
  Buffers: shared hit=21
Planning Time: 0.348 ms
Execution Time: 384.775 ms
```

**Reading it.** Identical plan, identical buffers (6,176, both sides): `postings_account_id_id_idx`
is never named in either plan, because this query has no account to filter by — it aggregates
every posting in the book by construction (`Seq Scan on postings` reading all 500,000 rows either
way). 374.505 ms → 384.775 ms is +2.7%, run-to-run noise on a 500,000-row scan, not a regression.
See "What did not improve" below.

## postings-page

One page from `listPostings`: the account's postings after a keyset cursor, oldest first, one
row over the page size so the caller can tell whether a next page exists.

```sql
select "postings"."id", "postings"."entry_id", "postings"."amount_minor", "postings"."currency", "entries"."occurred_at", "entries"."recorded_at", "entries"."description" from "postings" inner join "entries" on "entries"."id" = "postings"."entry_id" where ("postings"."account_id" = $1 and "postings"."id" > $2) order by "postings"."id" asc limit $3
```

**Baseline**

```text
Limit  (cost=0.84..868.85 rows=51 width=63) (actual time=0.036..0.560 rows=51 loops=1)
  Buffers: shared hit=285
  ->  Nested Loop  (cost=0.84..31640.66 rows=1859 width=63) (actual time=0.036..0.557 rows=51 loops=1)
        Buffers: shared hit=285
        ->  Index Scan using postings_pkey on postings  (cost=0.42..20884.11 rows=1859 width=36) (actual time=0.023..0.399 rows=51 loops=1)
              Index Cond: (id > '125100'::bigint)
              Filter: ((account_id = '047086dd-749b-455c-be99-5126194a02e9'::uuid) AND (book_id = (NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid))
              Rows Removed by Filter: 5049
              Buffers: shared hit=81
        ->  Index Scan using entries_pkey on entries  (cost=0.42..5.79 rows=1 width=43) (actual time=0.003..0.003 rows=1 loops=51)
              Index Cond: (id = postings.entry_id)
              Filter: (book_id = (NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid)
              Buffers: shared hit=204
Planning:
  Buffers: shared hit=9
Planning Time: 0.167 ms
Execution Time: 0.604 ms
```

**Indexed**

```text
Limit  (cost=0.84..475.10 rows=51 width=63) (actual time=0.036..0.282 rows=51 loops=1)
  Buffers: shared hit=258
  ->  Nested Loop  (cost=0.84..17408.82 rows=1872 width=63) (actual time=0.036..0.279 rows=51 loops=1)
        Buffers: shared hit=258
        ->  Index Scan using postings_account_id_id_idx on postings  (cost=0.42..6598.42 rows=1872 width=36) (actual time=0.021..0.077 rows=51 loops=1)
              Index Cond: ((account_id = '047086dd-749b-455c-be99-5126194a02e9'::uuid) AND (id > '125100'::bigint))
              Filter: (book_id = (NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid)
              Buffers: shared hit=54
        ->  Index Scan using entries_pkey on entries  (cost=0.42..5.77 rows=1 width=43) (actual time=0.004..0.004 rows=1 loops=51)
              Index Cond: (id = postings.entry_id)
              Filter: (book_id = (NULLIF(current_setting('app.current_book_id'::text, true), ''::text))::uuid)
              Buffers: shared hit=204
Planning:
  Buffers: shared hit=17
Planning Time: 0.309 ms
Execution Time: 0.326 ms
```

**Reading it.** Both plans already use an index scan on `postings`, so this was never a
sequential-scan case — the baseline uses `postings_pkey` and filters `account_id` afterward
(5,049 rows removed), while the indexed plan carries both `account_id` and `id` in one
`Index Cond` on `postings_account_id_id_idx`, cutting the scan's own buffers from 81 to 54.
Total buffers fall 285 → 258 (−9%) and execution time 0.604 ms → 0.326 ms (−46%).

## Summary

| Query | Baseline | Indexed | Factor |
|---|---|---|---|
| `balance-from-zero` | 20.826 ms (13,678 buffers) | 14.889 ms (10,018 buffers) | 1.40× faster |
| `balance-from-checkpoint` — checkpoint lookup | 0.049 ms (3 buffers) | 0.058 ms (3 buffers) | unchanged (different table; both sub-ms, noise) |
| `balance-from-checkpoint` — delta sum | 15.113 ms (4,247 buffers) | 0.045 ms (3 buffers) | 336× faster |
| `lowest-prefix` (default settings) | 21.352 ms (16,207 buffers) | 57.764 ms (5,692 buffers) | 2.71× slower |
| `trial-balance` | 374.505 ms (6,176 buffers) | 384.775 ms (6,176 buffers) | unchanged (+2.7%, noise) |
| `postings-page` | 0.604 ms (285 buffers) | 0.326 ms (258 buffers) | 1.85× faster |

Arithmetic, by hand, from the buffers and `Execution Time` lines pasted above:

- `balance-from-zero`: 20.826 / 14.889 = 1.399 → **1.40× faster**.
- checkpoint lookup: 0.049 / 0.058 = 0.845 — indexed is nominally *slower*; both figures are
  sub-millisecond noise on an unindexed table this migration never touches.
- delta sum: 15.113 / 0.045 = 335.8 → **336× faster** (rounded); buffers 4,247 / 3 = 1,415.7×
  fewer.
- `lowest-prefix`: 57.764 / 21.352 = 2.705 → **2.71× slower** ((57.764 − 21.352) / 21.352 = 1.705,
  i.e. +171%).
- `trial-balance`: 384.775 / 374.505 = 1.027 → **+2.7%**, within run-to-run noise.
- `postings-page`: 0.604 / 0.326 = 1.853 → **1.85× faster**; buffers 285 / 258 = 1.105× fewer
  (−9%).

## What did not improve, and why that is expected

- **`trial-balance`** is flat — 374.505 ms → 384.775 ms, +2.7%, both plans an identical
  `Seq Scan on postings` reading all 500,000 rows. It aggregates the whole book by construction
  (`LEFT JOIN postings ... GROUP BY accounts.id`), so no index that narrows a scan to one account
  changes how many rows this query must read. This is the predicted result, not a miss.

- **`balance-from-checkpoint`'s checkpoint lookup** is flat — 0.049 ms → 0.058 ms, 3 buffers both
  ways. It reads `balance_checkpoints`, a table this migration adds no index to.

- **`postings_entry_id_idx` — measured and dropped.** Task 3's migration originally shipped a
  second index, `(entry_id)`, alongside the one above; `explain.ts --mode indexed` creates it for
  every indexed capture, including the ones pasted in this document. It never appears in any plan
  above — every join from `postings` to `entries`, in all five queries, looks up `entries`'s own
  primary key (`entries_pkey` / `entries_id_book_id_key`) starting from a `postings` row already
  in hand; none of the five ever needs to go the other direction and find `postings` rows by
  `entry_id`. That is the predicted shape for a foreign-key index that exists to make deletes
  cheap on a table nothing ever deletes from. The index was removed from
  [`0009_indexes.sql`](../apps/api/drizzle/0009_indexes.sql) and from `schema.ts` before this
  migration shipped — a null result, recorded here rather than carried forward as a permanent
  write cost with a story attached.

- **`lowest-prefix`, under default planner settings, got slower, not faster** — 21.352 ms →
  57.764 ms. This is the one item in this section that is a real regression rather than an
  expected flat line; it has its own reading above and is carried forward as an open item below.

## What this does not fix

**The overdraft scan is still O(account history) under a row lock.** `postings_account_id_id_idx`
changes how `lowest-prefix` finds an account's postings — an index probe instead of a table
scan — but the query still reads and window-aggregates every posting the account has ever made,
every time it runs, while holding that account's row lock (in the entry-insert critical section)
and again in the deferred trigger at COMMIT. An account with ten times the history pays roughly
ten times the cost of this scan, indexed or not. The checkpoint design (stage 7's other half)
does not help here: `getBalance`'s checkpoint path only accelerates a *balance read*
(`balance-from-checkpoint`'s delta sum, the headline win above); `lowestPrefixBalance` has no
checkpoint of its own to resume from; it must establish the true minimum over the account's
entire ordered history, from the start, on every call.

**The `lowest-prefix` regression ships open, not resolved.** Under this document's own default
planner settings — the settings this application actually runs under — `lowest-prefix` is
slower with the index than without it: 21.352 ms → 57.764 ms. The forcing experiment above shows
the fix (a cost constant, not a schema change) and that it works, but neither `SET` ships. Anyone
deploying this schema onto a workload with `lowest-prefix` in a hot path should read the "Ruling"
section above before assuming the index is a clean win everywhere it touches.

**`sumPostings`'s unconditional join to `entries`** (named under `balance-from-zero` above)
remains unconditional. It costs over half of that query's buffers in both baseline and indexed
mode and is not exercised by anything `asOf` would need when `asOf` is unset. Named here as a
candidate an `asOf`-conditional join would address; not implemented in this task.

## Reproducing it

```bash
pnpm db:nuke && pnpm db:up && pnpm db:migrate
```

```bash
pnpm --filter @ledger/api perf:seed
```

```bash
pnpm --filter @ledger/api checkpoint <bookId>
```

```bash
pnpm --filter @ledger/api perf:explain --book <bookId> --mode baseline > baseline.md
pnpm --filter @ledger/api perf:explain --book <bookId> --mode indexed > indexed.md
```

`<bookId>` is printed by `perf:seed`. The first command is required, not optional: `perf:seed`'s
verification queries are database-wide (see "The corpus" above), so a database holding data from
an earlier run produces spurious verification failures rather than a clean load.
