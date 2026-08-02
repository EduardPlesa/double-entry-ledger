# Stage 5 — property-based tests and the query-count guard

Status: approved 2026-08-03.

Builds on stage 4 (the overdraft rule, row locks, the `serializable` alternative). Everything
the previous four stages asserted, it asserted about cases someone thought of. This stage
states the same invariants as properties over arbitrary command sequences and lets fast-check
look for the cases nobody thought of, against the real database rather than a model of it.

Second deliverable, unrelated to the first except in being a test that fails on a class of
regression rather than on a case: a query-count assertion, so an N+1 on the read paths fails CI.

## Goals

- The ledger's invariants stated as properties over generated sequences, checked against a real
  Postgres with its triggers and row-level security in force.
- The concurrent invariants — value conserved, the overdraft rule unbroken — stated over
  generated batches fired through genuinely parallel connections.
- A query-count helper and assertions that fail when a read path's round trips grow with the
  size of its result.
- A regression corpus mechanism, populated by whatever the properties actually find.

## Non-goals

- Replacing any example-based test. Properties find cases nobody thought of; the existing suites
  pin the cases someone did, and when one breaks it says what broke in a sentence. A shrunk
  counterexample says it in a data structure. Both are wanted.
- `EXPLAIN ANALYZE`, indexes, balance checkpoints. Stage 7. The query-count assertion here is
  deliberately about the number of round trips, which is a property of the code; plan quality is
  a property of the data and belongs with the seeded half-million postings.
- Predicting which entries the service will refuse. See "The model follows" below — this is the
  central design decision of the stage, not an omission.
- Frontend. Stage 6.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| What the properties drive | `LedgerService` against the Testcontainers database | The invariants this project is about are enforced half in TypeScript and half in migrations `0003` and `0007`. A property run against an in-memory reimplementation proves the reimplementation correct and says nothing about the triggers, the deferred constraint, or the prefix rule's window function. The cost is real — a case is a book seed plus a few dozen round trips — and is paid by keeping `numRuns` small and the properties dense. |
| How sequences are expressed | `fc.commands` with an in-memory model advanced alongside | Reversal is inherently stateful: it needs an entry that exists and has not already been reversed. A flat array of entries either cannot express that or expresses it with indices that shrinking mangles. Commands also shrink to a *minimal sequence*, which is the artifact the stage brief asks to promote into a regression test. |
| What the model does on a rejection | Records nothing, and never predicts | Discussed at length below. |
| The concurrent property | fast-check generates the batch shape; the harness fires it over real pool connections | `fc.scheduler` shrinks interleavings of JS `await` points. The thing stage 4 proved dangerous was Postgres commit ordering under READ COMMITTED, which no JS scheduler observes or controls. Generating the shape and firing for real keeps the subject intact and gives up deterministic replay, which the shape's own shrinking partly recovers. |
| How statements are counted | The pool's `connect` event, wrapping each client's `query` | Counts every statement the process sends: `BEGIN`, `set_config`, `COMMIT`, and any raw `pool.query` that never went through drizzle. Drizzle's `logger` option sees only what drizzle itself issued, which excludes precisely the kind of round trip that gets added without anyone noticing. |
| The regression corpus | Transcribed cases in a file, replayed via fast-check's `examples` | A recorded seed and shrink path is one line and reproduces nothing once a generator changes. A transcribed case states what it defends against and survives the generator being rewritten, which is the only form in which it is still a regression test in a year. |

## The harness

`fast-check` `^4.9.0` as a devDependency of `apps/api`. New directory `tests/properties/`, new
vitest project `properties`: the same global Postgres setup as `integration`, single worker, its
own timeout.

A fourth project rather than folding into `integration`, for the reason `vitest.config.ts`
already gives about the other three. A property run costs tens of seconds. Put it in
`integration` and every run of the suite people execute while editing pays for it, and the
pressure is then to shrink `numRuns` until the properties stop being properties.

`numRuns` comes from `LEDGER_PROPERTY_RUNS`, defaulting to 25. Read in a test helper, which is
already outside the `process.env` ban — `eslint.config.js` exempts `apps/api/tests/**`.

## The model follows; the invariants judge

The model records **only what the system accepted**. On `AccountOverdrawnError` it records
nothing and the sequence continues. It contains no reimplementation of the prefix rule and makes
no claim about which entries should be refused.

The alternative was a model that predicts rejections and asserts the system agrees. It catches
one more class of bug — an entry wrongly refused — at the price of a third copy of the overdraft
rule, after the SQL in `0007` and the service's own check. Three copies, and a disagreement
between them names no culprit.

So the properties are about the states the system can reach, not about the decisions it makes
getting there:

```ts
interface ModelPosting {
  accountId: string;
  amountMinor: bigint;
  occurredAt: Date;
  /** Monotone counter standing in for postings.id — the prefix rule's tiebreaker. */
  seq: number;
}
```

No balance is stored on the model as a mutable number. Balances are summed from `postings` when
asked, which is invariant 4 of this project applied to the test double as well as to the system.

### The known hole

A service that refused every entry would satisfy every invariant below. Vacuous truth is the
standing failure mode of property-based testing, and this design has it by construction: that is
the price of not predicting rejections.

The guard is coverage accounting, not a second copy of the rule. The harness tallies accepted
against rejected `PostEntry` commands across the whole `fc.assert` run and asserts afterwards
that both counts are non-zero and acceptances are the clear majority, reporting the distribution
either way. It catches the degenerate service and it catches a generator that has drifted into
producing entries nothing will accept — which is the same failure wearing different clothes, and
the more likely of the two.

## The invariants

Checked after **every** command, not only after reads.

1. **Book-wide zero sum, per currency.** One grouped query against the database; the model
   agrees. This is invariant 1 of the project, asserted over sequences rather than over a case.

2. **Per-account balance equals the sum of its own postings.** `service.getBalance` against the
   model's independently accumulated sum.

   This is the load-bearing one. It ties the model to the database, and every other assertion
   made against the model is an assertion about real data only because this one holds.

3. **The trial balance agrees.** `service.trialBalance` rows match the model's per-account sums,
   grouped by type, with total debits equal to total credits.

4. **No guarded account's minimum prefix is below zero.** The model scans its own postings in
   `(occurredAt, seq)` order for every guarded account in the book, and each one is cross-checked
   against `repository.lowestPrefixBalance` for the same account.

   The cross-check is not the rule written twice. It is one total order computed twice by
   independent means — a SQL window function against a TypeScript array scan. The generator makes
   ties at equal `occurredAt` common on purpose, so this is the assertion that pins the
   tiebreaker that stage 4's design argued for.

5. **A reversal's delta is exactly the negation of the original's legs.** Balances snapshotted
   before the reversal, applied, compared. Checked only when the reversal was accepted; a
   reversal the overdraft rule refused changes no balance and asserts nothing here, which is the
   same discipline the model applies to a refused `PostEntry`.

   The brief phrases this as "posting an entry then reversing it restores every affected
   balance." That is the special case where nothing landed in between. The delta form is stronger
   and stays checkable in the middle of a generated sequence, which is where it will actually run.

## Commands

Five, each with a `check` precondition so only valid ones fire. `maxCommands: 12`.

**`PostEntry`** — generated balanced legs, through `service.postEntry`. On
`AccountOverdrawnError`, record nothing. On any other error, fail. The generator emits only
well-formed entries naming real accounts with matching currencies, so an `ENTRY_UNBALANCED`, a
currency mismatch or an unmapped 500 from this path is a genuine find and must not be swallowed
as "the rule refused it."

**`ReverseEntry`** — the k-th unreversed entry in the model, `k mod count`, skipped when there
are none. Same error discipline, plus invariant 5.

**`ReadBalance`** — one account against the model.

**`ReadTrialBalance`** — the full report against the model.

**`ReadPostings`** — pages through `listPostings` to exhaustion, asserting both that the page set
equals the model's postings for the account and that the running-balance column equals the true
prefix sum *in cursor order*. Cursor pagination carrying a running balance is the one place in
this system where a correct total can be assembled out of incorrect parts, and the only way to
see it is to check every row rather than the last.

Cost is roughly 120 round trips per case, which is about ten seconds for 25 runs against a local
container.

## Generators

**Accounts** come from the existing `seedBook` fixture, plus an opening entry funding `cash` from
`sales`. Without opening funds nearly every `PostEntry` is refused, the coverage guard above
fires, and rightly — an unfunded book exercises one branch of the overdraft rule and nothing
else. Amounts are drawn up to roughly twice the opening balance, so refusals happen because the
generator aimed at them rather than by accident.

**Balanced legs**: pick a currency, pick two to four accounts holding it, generate n−1 arbitrary
amounts, set the last to the negation of their sum. Reject the all-zero draw. A multi-currency
entry concatenates two such groups, so each currency group sums to zero on its own — the
per-currency grouping invariant under generated load rather than in a hand-written case.

The model keys balances by account, and an account carries exactly one currency by schema, so
multi-currency costs the model nothing.

**`occurredAt`** is drawn from a small fixed set of timestamps around a fixed injected `Clock`.
Small deliberately: backdating then happens constantly and ties are common, which is what
invariants 4 and 5 need in order to be interesting rather than incidental. A fixed clock makes a
run deterministic apart from generated ids.

## The concurrent property

`tests/concurrency/conservation.property.test.ts`, in the existing `concurrency` project — forks
pool, one file at a time. `numRuns` default 15: real parallelism is expensive, and the
interesting cases here are shallow.

fast-check generates the batch shape — N in [2, 8], the opening balance, and N transfer specs
drawn so each is individually affordable while the batch collectively is not. The harness fires
them at once through real pool connections. `fireConcurrently` in `tests/helpers/concurrency.ts`
generalizes from N copies of one withdrawal to a list of specs.

The outcome is legitimately nondeterministic, so the assertions are confined to what must hold
whichever subset commits:

- Value is conserved: the book still sums to zero per currency.
- No guarded account's minimum prefix is below zero.
- The committed entry count equals the number of fulfilled results. Neither a lost commit nor a
  phantom one can hide inside a rejection.
- Every rejection is `ACCOUNT_OVERDRAWN`, or under `serializable` a `40001` that exhausted its
  retries. A deadlock, a constraint violation or an unmapped 500 fails the property.

Parameterized over both strategies, as stage 4's race test already is.

## Query counting

`tests/helpers/query-count.ts` instruments a pool at creation through its `connect` event,
wrapping each client's `query` for the duration of a measured block:

```ts
export function instrumentPool(pool: Pool): QueryRecorder;
// recorder.measure(async () => { ... }) → { result, statements: string[] }
```

It records statement **text**, not only a count. A failure naming the seven statements that ran
is actionable; "expected 6, got 7" sends the reader to a debugger.

Counting at the driver means `BEGIN`, `set_config` and `COMMIT` are counted. That is intended:
the number an N+1 assertion is about is the number of round trips, not the number of statements
an ORM elected to report.

`tests/services/query-count.test.ts` — an example-based test in the `integration` project, not a
property — asserts:

- **`listPostings` is invariant to page size.** A page of 1 and a page of 50 execute the same
  statements. This is the N+1 guard proper.
- **The exact count is pinned**, with a comment naming each statement in order. Invariance
  catches the regression; the exact count catches creep.
- **`trialBalance` is invariant to account count.** Two accounts and twenty, same statements. The
  other endpoint shaped like an N+1 waiting to happen.

## The regression corpus

`tests/properties/regressions.ts` exports transcribed counterexamples, fed to every property
through fast-check's `examples` option. They replay on every run at negligible cost and state in
the test what they defend against.

It ships empty. Whatever the properties genuinely find is transcribed there with its story in a
new property-testing section of the README. If they find nothing, the README says the corpus is
empty and why. No bug is planted to manufacture a worked example.

## Files

New:

```
apps/api/tests/properties/arbitraries.ts
apps/api/tests/properties/model.ts
apps/api/tests/properties/commands.ts
apps/api/tests/properties/ledger.property.test.ts
apps/api/tests/properties/regressions.ts
apps/api/tests/helpers/query-count.ts
apps/api/tests/services/query-count.test.ts
apps/api/tests/concurrency/conservation.property.test.ts
```

Modified:

```
apps/api/package.json                    fast-check ^4.9.0
apps/api/vitest.config.ts                the properties project
apps/api/tests/helpers/concurrency.ts    fireConcurrently over arbitrary specs
README.md                                the property-testing story, the corpus
```
