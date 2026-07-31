-- What ledger_app is allowed to do with the auth tables.
--
-- Migration 0002 made the same argument for entries and postings: the runtime role gets the
-- narrowest set of verbs the application actually needs, and the REVOKEs standing next to
-- the GRANTs are there so a later migration widening one reads as a contradiction rather
-- than as an innocent addition.
--
-- The line these tables draw is different from the one history draws. entries and postings
-- are append-only because a ledger that can be edited is not a ledger. These five are
-- mutable in specific, named ways - a token is redeemed, a key is used, an idempotent
-- request completes - and the column-level grants below say exactly which ways. What none
-- of them permits is DELETE. A revoked token, a revoked key and a spent idempotency key are
-- all evidence, and evidence the runtime role can delete is evidence an intruder deletes
-- first.

GRANT SELECT, INSERT ON TABLE users TO ledger_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE users FROM ledger_app;--> statement-breakpoint

-- No UPDATE on users at all, which means no password change and no email change. Both are
-- real features and neither exists yet; granting the capability before the feature leaves it
-- lying around with nothing using it. Stage 7's limitations document says so out loud rather
-- than leaving it to be discovered.

-- Redeeming a token, revoking a family and linking a token to its successor are all UPDATEs,
-- so this table cannot be append-only. Column-level grants are what stop that from meaning
-- "anything goes": the runtime role can move a token forward through its lifecycle and
-- cannot rewrite whose it is, what it hashes to, or when it expires.
GRANT SELECT, INSERT ON TABLE refresh_tokens TO ledger_app;--> statement-breakpoint
GRANT UPDATE (redeemed_at, revoked_at, replaced_by) ON TABLE refresh_tokens TO ledger_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE refresh_tokens FROM ledger_app;--> statement-breakpoint

-- A role can be changed - that is what member management is - but a membership cannot be
-- withdrawn by the runtime role. Demoting to viewer is the supported way to take access
-- away, and it leaves a row behind saying the person was once there.
GRANT SELECT, INSERT ON TABLE book_members TO ledger_app;--> statement-breakpoint
GRANT UPDATE (role) ON TABLE book_members TO ledger_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE book_members FROM ledger_app;--> statement-breakpoint

GRANT SELECT, INSERT ON TABLE api_keys TO ledger_app;--> statement-breakpoint
GRANT UPDATE (last_used_at, revoked_at) ON TABLE api_keys TO ledger_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE api_keys FROM ledger_app;--> statement-breakpoint

-- The reserved row is completed in place, and nothing else about it may move: rewriting
-- request_fingerprint after the fact would turn "this key was reused for a different
-- request", which is a detectable client bug, into a silently plausible replay.
-- Expired idempotency keys and expired refresh tokens therefore accumulate, and nothing on
-- the request path can remove them. That is the intended shape: reclaiming the space is an
-- operator's job, run deliberately as ledger_owner, rather than a capability the application
-- carries around in case it is ever needed.
--
-- No sequence grants either. Every table added in 0004 has a caller-supplied uuid or a
-- composite natural key, so unlike postings there is no sequence to grant USAGE on.

GRANT SELECT, INSERT ON TABLE idempotency_keys TO ledger_app;--> statement-breakpoint
GRANT UPDATE (status, response_body, entry_id, completed_at) ON TABLE idempotency_keys TO ledger_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE idempotency_keys FROM ledger_app;
