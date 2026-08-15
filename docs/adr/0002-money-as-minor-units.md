# 2. Money is a bigint in minor units

Date: 2026-07-30
Status: accepted

Written in stage 7, after the fact. The decision was taken when `packages/shared/src/money.ts`
and the schema's `amount_minor` column were written; this record collects an argument those
files already carry.

## Context

Two things are true about JavaScript numbers and neither is fixable at the call site.

A `number` is an IEEE 754 double, so `0.1 + 0.2` is not `0.3`. Money in floats produces a
ledger whose totals depend on the order the additions happened in, and the errors are small
enough to survive review and numerous enough to matter.

A `number` also loses integers past 2^53. That bound is not theoretical for a ledger:
2^53 minor units is about 90 trillion euros, which sounds enormous until the currency is one
with a small unit - and it is a bound a `bigserial` posting id has to clear as well, since ids
are counted per row rather than per euro.

JSON has neither a decimal type nor a bigint, which means the wire format is a separate
decision from the storage one and both have to be made.

## Decision

**Storage and computation: `bigint`, in the currency's minor unit.** `postings.amount_minor` is
a `bigint` column, and drizzle is configured with `mode: 'bigint'` so a JS `bigint` comes back
rather than a string that has to be converted at every call site. Every arithmetic operation on
money is exact integer arithmetic, and `Money` is `{ amountMinor: bigint, currency: string }` -
the currency travels with the amount, so adding EUR to USD is a thrown `CurrencyMismatchError`
rather than a plausible number.

**The wire: decimal strings.** `"12.34"`, never `12.34` and never `1234`. Strings because a JSON
number is a double and a ledger that cannot round-trip its own values through its own API is not
one to put money in. *Decimal* rather than minor units because the alternative makes every
client learn that JPY has no minor unit and KWD has three; that table lives in `money.ts` and
both sides import it.

**One boundary.** `parseMoney` and `formatMoney` are the only conversions. `parseMoney` pads
fewer decimal places than the currency has and *rejects* more rather than rounding: only the
caller knows whether a half-cent goes up, down or to a rounding account, and choosing silently
is how a ledger drifts by amounts too small to notice and too many to find.

**Posting ids are strings on the wire too.** Same argument, different column: `postings.id` is a
`bigserial`, and a JavaScript client parsing it as a number would round it without noticing.

## Consequences

- **Every SQL aggregate needs a `::text` cast.** `sum()` over `bigint` returns `numeric`, and
  `numeric` arrives from node-postgres as a string anyway - but only after passing through a
  path where a driver configuration change could turn it into a `number`. So every sum in
  `ledger.repository.ts` is written `coalesce(sum(amount_minor), 0)::text` and converted with
  `BigInt(...)` explicitly. Forgetting one is a class of bug that behaves perfectly until the
  total passes 2^53, which is to say it is a bug that ships.
- **Serialisation is explicit, per resource.** `JSON.stringify` throws on a `bigint`, and the
  two ways to make it stop - `BigInt.prototype.toJSON`, or a replacer - both give *every*
  bigint in the process a silent serialisation, including ones that should never have reached a
  response. `http/serialize.ts` has one function per resource instead, which makes adding a
  field to a response a deliberate act.
- **The API's amounts are validated by shape, not by type.** A decimal string can be malformed
  in ways a number cannot, so `parseMoney` throws on anything that is not one, and the published
  schema carries the pattern (`moneyString` in `packages/shared/src/contracts/responses.ts`).
- **Nothing here handles more than one currency per account.** The currency travels with the
  amount and mismatches are rejected; that is not FX. There is no rate table, no revaluation and
  no multi-currency entry - see `docs/limitations.md`.
