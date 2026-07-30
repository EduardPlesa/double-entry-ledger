-- Row-level security: a book is a hard boundary, enforced by the database.
--
-- The application already checks membership before it queries anything. This exists because
-- that check is one `if` away from being skipped, and a WHERE clause is one forgotten join
-- condition away from being wrong. A policy is neither: it is applied to every statement the
-- runtime role issues, including the ones written next year, including the ones written in
-- psql by someone debugging at midnight.
--
-- The setting is transaction-local. `db/client.ts` issues
--
--     select set_config('app.current_book_id', $1, true)
--
-- as the first statement of every book-scoped transaction, after membership has been
-- resolved. SET LOCAL takes no bind parameter, which is why it is set_config with
-- is_local => true and not string interpolation into SQL text.
--
-- Transaction-local rather than session-local is not a detail. Connections come from a pool
-- and outlive the request that borrowed them; a session-level setting would still be there
-- for whoever borrows the connection next, which is a cross-tenant data leak with a
-- plausible-looking cause.


-- ---------------------------------------------------------------------------------------
-- The policies.
--
-- current_setting(name, true) - note the second argument - returns NULL instead of raising
-- when the setting has never been set. NULL then makes `book_id = NULL` evaluate to NULL,
-- which is not true, which is zero rows. So a query that forgot to establish a book context
-- returns nothing rather than erroring, and, far more importantly, rather than returning
-- everything. The failure mode is closed by construction.
--
-- nullif(..., '') covers the other shape of absent. A setting that has been set and then
-- reset within the transaction reads back as the empty string rather than NULL, and ''::uuid
-- raises invalid_text_representation - which would turn a missing book context into a 500
-- instead of an empty result, and would do it from inside a policy where the cause is far
-- from obvious.
--
-- FOR ALL with both USING and WITH CHECK: USING filters what can be read (and what an
-- UPDATE or DELETE can see), WITH CHECK constrains what can be written. Without the latter,
-- a caller scoped to book A could insert a row belonging to book B and then be unable to
-- see the thing they had just created.
--
-- These policies bind ledger_app and not ledger_owner, because a table's owner is exempt
-- from its own policies unless FORCE ROW LEVEL SECURITY is set. That exemption is load
-- bearing twice over: migrations run as the owner and must see everything, and
-- assert_entry_balanced() from migration 0003 is SECURITY DEFINER precisely so that it
-- aggregates every posting of an entry rather than the subset the caller may see. An entry
-- that balances only under the caller's policy is not a balanced entry.

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY accounts_book_isolation ON accounts
	FOR ALL
	TO ledger_app
	USING (book_id = nullif(current_setting('app.current_book_id', true), '')::uuid)
	WITH CHECK (book_id = nullif(current_setting('app.current_book_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE entries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY entries_book_isolation ON entries
	FOR ALL
	TO ledger_app
	USING (book_id = nullif(current_setting('app.current_book_id', true), '')::uuid)
	WITH CHECK (book_id = nullif(current_setting('app.current_book_id', true), '')::uuid);--> statement-breakpoint

-- postings.book_id is denormalised from entries, and migration 0001 said this was the
-- reason: the composite foreign key makes disagreement with entries.book_id physically
-- impossible, so the policy on the hottest read path in the system is a column comparison
-- rather than a correlated subquery against entries on every row.
ALTER TABLE postings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY postings_book_isolation ON postings
	FOR ALL
	TO ledger_app
	USING (book_id = nullif(current_setting('app.current_book_id', true), '')::uuid)
	WITH CHECK (book_id = nullif(current_setting('app.current_book_id', true), '')::uuid);--> statement-breakpoint

-- books is deliberately left without a policy. A user has to be able to discover which
-- books they belong to before any book can be the current one, and that read is guarded by
-- book_members. Putting books behind the same setting would make listing them impossible
-- without first knowing which one to list.


-- ---------------------------------------------------------------------------------------
-- Breaking the resolution cycle.
--
-- GET /accounts/:id/balance arrives with an account id and no book. Resolving the book means
-- reading accounts, and accounts is now behind a policy keyed on the book - so the lookup
-- needs the answer it is trying to find.
--
-- These two functions break that cycle, and the way they are written is the whole argument
-- for why they are safe:
--
--   SECURITY DEFINER  - runs as ledger_owner, which the policies do not apply to.
--   STABLE            - no side effects; the planner may cache within a statement.
--   SET search_path   - pinned, because a SECURITY DEFINER function without one is a
--                       privilege escalation waiting for someone to create a shadowing
--                       object earlier on the path.
--   RETURNS uuid      - one column. Not a row, not the account, not its balance.
--
-- What a caller learns is which book an id belongs to, and nothing else. They still have to
-- be a member of that book before a single row of data comes back, and if they are not, the
-- HTTP layer answers 404 rather than 403 so that membership is not enumerable either.
--
-- REVOKE FROM PUBLIC first: EXECUTE on a new function is granted to PUBLIC by default, and
-- a SECURITY DEFINER function that everyone may call is the classic way this pattern goes
-- wrong.

CREATE FUNCTION book_of_account(p_account_id uuid) RETURNS uuid
	LANGUAGE sql
	STABLE
	SECURITY DEFINER
	SET search_path = pg_catalog, public
	AS $$
		SELECT a.book_id FROM public.accounts a WHERE a.id = p_account_id
	$$;--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION book_of_account(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION book_of_account(uuid) TO ledger_app;--> statement-breakpoint

CREATE FUNCTION book_of_entry(p_entry_id uuid) RETURNS uuid
	LANGUAGE sql
	STABLE
	SECURITY DEFINER
	SET search_path = pg_catalog, public
	AS $$
		SELECT e.book_id FROM public.entries e WHERE e.id = p_entry_id
	$$;--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION book_of_entry(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION book_of_entry(uuid) TO ledger_app;
