-- The overdraft rule, enforced in the database.
--
--   LG004  a guarded account would be left negative at some point in its history


-- ---------------------------------------------------------------------------------------
-- Which account types may not go negative.
--
-- A function rather than a literal inside the trigger, so that the duplication between here
-- and `domain/overdraft.ts` is something a test can compare rather than something a reader
-- has to notice. `tests/db/overdraft.trigger.test.ts` asserts the two lists are equal.
--
-- IMMUTABLE because the answer is fixed by accounting, not by data: an asset account is the
-- one that holds a thing, and a thing cannot be held in negative quantity.
CREATE FUNCTION guarded_account_types() RETURNS public.account_type[]
	LANGUAGE sql
	IMMUTABLE
	PARALLEL SAFE
	SET search_path = pg_catalog, public
	AS $$ SELECT ARRAY['asset']::public.account_type[] $$;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION guarded_account_types() TO ledger_app;--> statement-breakpoint


-- ---------------------------------------------------------------------------------------
-- LG004 - a guarded account's balance is never negative, at any point in its history.
--
-- "At any point" and not "at the end", because `occurred_at` is asserted by the caller and
-- an entry recorded today can land in the past. A rule about the current balance alone would
-- accept a backdated withdrawal that overdrew the account on the very date it describes.
--
-- Ordered by (occurred_at, id). The tiebreaker is not decoration: two legs of one entry
-- always share an occurred_at, so without it the window has no defined order among them and
-- the minimum is whatever the plan happened to produce. `postings.id` is a bigserial, so it
-- is a total order consistent with the sequence rows were recorded in.
--
-- A CONSTRAINT TRIGGER for the same two reasons as LG001: the invariant is a property of a
-- set of rows rather than of one, and it is legitimately false partway through the
-- transaction that establishes it - an entry's negative leg may be inserted before the
-- positive one that funds it.
--
-- SECURITY DEFINER for the same reason too. `postings` is behind row-level security, and a
-- SECURITY INVOKER function would sum only the rows the current role can see, so an account
-- could pass here while being overdrawn in fact.
--
-- What this does NOT do is make the rule safe under concurrency. The query runs at COMMIT
-- and, under READ COMMITTED, takes a fresh snapshot - so it sees transactions committed
-- since the statement that fired it, and the window in which two writers can both pass is
-- narrow. Narrow is not closed: two transactions committing at once can each check before
-- the other commits. See docs/adr/0004-concurrency-control.md; the row locks in the service
-- are what actually settles it.
CREATE FUNCTION assert_account_not_overdrawn() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
	AS $$
DECLARE
	lowest bigint;
	dipped_at timestamptz;
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM public.accounts a
		WHERE a.id = NEW.account_id
		  AND a.type = ANY (public.guarded_account_types())
	) THEN
		RETURN NULL;
	END IF;

	SELECT prefixes.running, prefixes.occurred_at
		INTO lowest, dipped_at
	FROM (
		SELECT
			sum(p.amount_minor) OVER (
				ORDER BY e.occurred_at, p.id
				ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
			) AS running,
			e.occurred_at AS occurred_at
		FROM public.postings p
		JOIN public.entries e ON e.id = p.entry_id
		WHERE p.account_id = NEW.account_id
	) prefixes
	ORDER BY prefixes.running ASC, prefixes.occurred_at ASC
	LIMIT 1;

	IF lowest < 0 THEN
		RAISE EXCEPTION 'account % would be overdrawn: its balance reaches % at %', NEW.account_id, lowest, dipped_at
			USING ERRCODE = 'LG004',
			      HINT = 'A guarded account may not hold a negative balance at any point in its history.';
	END IF;

	RETURN NULL;
END
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER postings_account_not_overdrawn
	AFTER INSERT ON postings
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION assert_account_not_overdrawn();
