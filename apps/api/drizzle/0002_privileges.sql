-- What ledger_app is allowed to do.
--
-- This is the first of two independent enforcements of the append-only invariant. It is
-- the cheaper and blunter one: the runtime connection is simply not capable of issuing a
-- successful UPDATE or DELETE against history, so an application bug cannot rewrite the
-- past even if every line of TypeScript above it is wrong. Migration 0003 adds the second
-- enforcement, which also binds ledger_owner.
--
-- The REVOKE statements are redundant against the narrow GRANTs directly above them -
-- ledger_app was never given UPDATE or DELETE in the first place. They stay because they
-- make the intent explicit and reviewable: a later migration that widens the GRANT will
-- read as a contradiction of a statement standing right next to it, rather than as an
-- innocent-looking addition.

GRANT SELECT, INSERT ON TABLE entries TO ledger_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE postings TO ledger_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE entries FROM ledger_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE postings FROM ledger_app;--> statement-breakpoint

-- postings.id is a bigserial, so inserting requires the sequence too.
GRANT USAGE, SELECT ON SEQUENCE postings_id_seq TO ledger_app;--> statement-breakpoint

-- books and accounts are not history. An account can be renamed, reparented or closed
-- (closed_at), so UPDATE is legitimate here. DELETE is not: an account with postings
-- cannot be removed without destroying the entries that reference it, and an account
-- without postings costs nothing to leave closed. Nothing in this domain is ever deleted.
GRANT SELECT, INSERT, UPDATE ON TABLE books TO ledger_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE accounts TO ledger_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE books FROM ledger_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE accounts FROM ledger_app;
