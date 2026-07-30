-- The two roles this system runs as.
--
--   ledger_owner - owns the schema. Only the migration CLI connects as this role.
--   ledger_app   - the runtime role. Migration 0002 gives it SELECT and INSERT on
--                  entries and postings and revokes UPDATE and DELETE.
--
-- Declared here rather than only in docker/initdb so the privilege model lives in git
-- next to the schema it protects. Idempotent because ledger_owner necessarily already
-- exists by the time this runs - it is the role running it - and because a cluster
-- provisioned by an operator may already have both.
--
-- No passwords. Credentials are an operator concern and do not belong in a migration; the
-- dev-only ones live in docker/initdb/00-bootstrap-roles.sql. On a cluster where this
-- statement actually creates ledger_app, the role cannot authenticate until someone sets
-- its password, which is the correct default.

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ledger_owner') THEN
		EXECUTE 'CREATE ROLE ledger_owner LOGIN CREATEROLE';
	END IF;

	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ledger_app') THEN
		EXECUTE 'CREATE ROLE ledger_app LOGIN';
	END IF;
END
$$;
