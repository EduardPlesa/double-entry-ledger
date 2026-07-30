-- Cluster bootstrap, not a schema migration.
--
-- Role *existence* is a chicken-and-egg problem that a migration cannot solve on its
-- own: the migration CLI connects as ledger_owner, so ledger_owner has to exist before
-- the first migration runs, and it cannot create itself. Login credentials are also an
-- operator concern, not something that belongs in version-controlled SQL.
--
-- So the split is:
--   here      - the two roles exist and can authenticate  (infrastructure)
--   migration - what those roles are allowed to do        (schema, in git)
--
-- Migration 0000 re-declares both roles idempotently, so bringing up a fresh cluster
-- that only has ledger_owner still works: there, the CREATE ROLE actually fires.
--
-- The passwords below are development-only. Real deployments provision these roles and
-- their secrets out of band and never run this file.

CREATE ROLE ledger_owner LOGIN PASSWORD 'ledger_owner_dev' CREATEROLE;
CREATE ROLE ledger_app LOGIN PASSWORD 'ledger_app_dev';

-- ledger_owner owns the schema, so it can create tables and, critically, is the only
-- role that can drop the invariant triggers installed in migration 0002.
ALTER DATABASE ledger OWNER TO ledger_owner;
ALTER SCHEMA public OWNER TO ledger_owner;

-- Nothing is world-accessible by default. ledger_app gets exactly the privileges
-- migration 0002 grants it, and nothing more.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ledger_app;
