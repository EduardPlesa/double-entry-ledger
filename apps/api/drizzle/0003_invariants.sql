-- The invariants, enforced in the database.
--
-- Custom SQLSTATEs, so callers can distinguish these from ordinary constraint failures
-- without matching on message text. Class 'LG' is in the range Postgres reserves for
-- user-defined conditions.
--
--   LG001  entry is unbalanced
--   LG002  attempt to mutate append-only history
--   LG003  entry has no postings


-- ---------------------------------------------------------------------------------------
-- LG001 - every entry's postings sum to exactly zero, per currency.
--
-- Why this cannot be a CHECK constraint:
--
--   1. A CHECK sees one row. The invariant is a property of a *set* of rows - all the
--      postings sharing an entry_id - and there is no way to aggregate siblings from
--      inside a row constraint. (A CHECK calling a function that queries the table would
--      parse, but Postgres does not re-evaluate CHECKs when *other* rows change, so it
--      would be enforced at insert time only and silently wrong thereafter.)
--
--   2. CHECK constraints are not deferrable. The invariant is false for most of the life
--      of the transaction that establishes it: the moment after the first leg of a
--      two-leg entry is inserted, the entry legitimately sums to a non-zero amount. Any
--      immediate check rejects every entry ever written.
--
-- Hence a CONSTRAINT TRIGGER, which is the only trigger form Postgres allows to be
-- DEFERRABLE, and which is therefore also necessarily AFTER and FOR EACH ROW. Deferred to
-- COMMIT, so the check runs exactly once the transaction claims to be finished.
--
-- SECURITY DEFINER is not decoration. Stage 3 puts row-level security on postings; a
-- SECURITY INVOKER function would then aggregate only the rows the current role is
-- permitted to see, and an entry could balance under RLS while being unbalanced in fact.
-- Running as the table owner, which RLS does not apply to, keeps the aggregate honest.
-- search_path is pinned because a SECURITY DEFINER function without one is a privilege
-- escalation waiting for someone to create a shadowing object.
CREATE FUNCTION assert_entry_balanced() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
	AS $$
DECLARE
	unbalanced record;
BEGIN
	SELECT p.currency, sum(p.amount_minor) AS total
		INTO unbalanced
	FROM public.postings p
	WHERE p.entry_id = NEW.entry_id
	GROUP BY p.currency
	HAVING sum(p.amount_minor) <> 0
	LIMIT 1;

	IF FOUND THEN
		RAISE EXCEPTION 'entry % is unbalanced: % postings sum to %', NEW.entry_id, unbalanced.currency, unbalanced.total
			USING ERRCODE = 'LG001',
			      HINT = 'Every entry must sum to zero independently in each currency it touches.';
	END IF;

	RETURN NULL;
END
$$;--> statement-breakpoint

-- FOR EACH ROW means an n-leg entry runs this check n times, each time reaching the same
-- verdict about the same set. That is wasted work, and it is unavoidable: a constraint
-- trigger cannot be FOR EACH STATEMENT. It is also bounded and small - entries have a
-- handful of legs, not thousands - and correctness at COMMIT is worth more than the
-- duplicated aggregate. Stage 7 revisits it with real numbers if it ever shows up.
CREATE CONSTRAINT TRIGGER postings_entry_balanced
	AFTER INSERT ON postings
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION assert_entry_balanced();--> statement-breakpoint


-- ---------------------------------------------------------------------------------------
-- LG003 - an entry has at least one posting.
--
-- Without this, the zero-sum trigger has a hole: it only fires on posting inserts, so an
-- entry with no postings at all is never examined and commits as vacuously balanced. That
-- would put a permanently meaningless row in a table nothing can delete.
CREATE FUNCTION assert_entry_has_postings() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
	AS $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM public.postings p WHERE p.entry_id = NEW.id) THEN
		RAISE EXCEPTION 'entry % has no postings', NEW.id
			USING ERRCODE = 'LG003';
	END IF;

	RETURN NULL;
END
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER entries_have_postings
	AFTER INSERT ON entries
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION assert_entry_has_postings();--> statement-breakpoint


-- ---------------------------------------------------------------------------------------
-- LG002 - entries and postings are append-only.
--
-- The second of the two enforcements. Migration 0002 removed ledger_app's *ability* to
-- mutate history; this removes anyone's, including ledger_owner's and including a
-- superuser's. The two are not redundant: the REVOKE is invisible to anyone reading the
-- schema and evaporates the moment a future migration widens a grant, while this trigger
-- fails loudly and names the rule. Only a role that can DROP the trigger can get past it,
-- and that is exactly the level of deliberateness the operation deserves.
--
-- Corrections happen by writing a reversing entry. There is no supported path to editing
-- one that has been recorded.
CREATE FUNCTION reject_history_mutation() RETURNS trigger
	LANGUAGE plpgsql
	AS $$
BEGIN
	RAISE EXCEPTION '% on % is not permitted: entries and postings are append-only', TG_OP, TG_TABLE_NAME
		USING ERRCODE = 'LG002',
		      HINT = 'Record a reversing entry instead.';
END
$$;--> statement-breakpoint

CREATE TRIGGER entries_immutable
	BEFORE UPDATE OR DELETE ON entries
	FOR EACH ROW
	EXECUTE FUNCTION reject_history_mutation();--> statement-breakpoint

CREATE TRIGGER postings_immutable
	BEFORE UPDATE OR DELETE ON postings
	FOR EACH ROW
	EXECUTE FUNCTION reject_history_mutation();--> statement-breakpoint

-- TRUNCATE is not a DELETE and row-level triggers never see it, so it would otherwise be
-- an unguarded way to erase every entry in the system. Statement-level, because that is
-- the only granularity TRUNCATE has.
CREATE TRIGGER entries_no_truncate
	BEFORE TRUNCATE ON entries
	FOR EACH STATEMENT
	EXECUTE FUNCTION reject_history_mutation();--> statement-breakpoint

CREATE TRIGGER postings_no_truncate
	BEFORE TRUNCATE ON postings
	FOR EACH STATEMENT
	EXECUTE FUNCTION reject_history_mutation();
