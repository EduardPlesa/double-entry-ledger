-- Balance checkpoints, keyed on posting id.
--
-- Derived data: every row here can be recomputed from `postings` alone, which is what makes
-- the agreement test in tests/properties/checkpoint.property.test.ts possible and what makes
-- a wrong checkpoint a performance bug rather than a correctness one - the sum-from-zero path
-- still exists and still answers the same question.
--
-- Append-only for ledger_app, by REVOKE, like entries and postings. Deliberately *without*
-- the owner-binding trigger those tables carry from migration 0003: this table is a cache,
-- and pruning superseded rows as the owner has to stay possible. What must not happen is a
-- checkpoint being edited in place, because then a wrong number leaves no trace of having
-- been wrong.

CREATE TABLE balance_checkpoints (
	"account_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"through_id" bigint NOT NULL,
	"balance_minor" bigint NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "balance_checkpoints_pkey" PRIMARY KEY ("account_id", "through_id"),
	CONSTRAINT "balance_checkpoints_through_id_positive" CHECK ("through_id" > 0)
);--> statement-breakpoint

-- Same book as the account it summarises. One constraint, and it is what lets book_id be
-- denormalised onto this table at all.
ALTER TABLE balance_checkpoints
	ADD CONSTRAINT "balance_checkpoints_account_same_book_fk"
	FOREIGN KEY ("account_id", "book_id") REFERENCES accounts ("id", "book_id");--> statement-breakpoint

GRANT SELECT, INSERT ON TABLE balance_checkpoints TO ledger_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE balance_checkpoints FROM ledger_app;--> statement-breakpoint

ALTER TABLE balance_checkpoints ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY balance_checkpoints_book_isolation ON balance_checkpoints
	FOR ALL
	TO ledger_app
	USING (book_id = nullif(current_setting('app.current_book_id', true), '')::uuid)
	WITH CHECK (book_id = nullif(current_setting('app.current_book_id', true), '')::uuid);
