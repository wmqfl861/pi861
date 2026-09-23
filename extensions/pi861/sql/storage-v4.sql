-- Storage service migration for pi861 (version storage-v4), additive over memory-v3.
-- Apply with a MIGRATION role (schema owner with explicitly provisioned BYPASSRLS),
-- not with the runtime role and not with the service identity role.
-- The migration tool (src/live/storage-service.ts migrateStorage) verifies the file
-- digest against the pi861_schema_migrations ledger before applying or skipping,
-- backs up existing tables first and writes a conflict report; this file only
-- defines the schema. Grants are operator provisioning steps (see footer comments).
BEGIN;

-- Server-side identity mapping: a worker authenticates with a bearer token; the
-- digest of that token (never the token itself) resolves to the principal identity.
-- Tenant and scopes come exclusively from this table, so a caller can never widen
-- its own authorization by self-asserting tenant/role/scope values.
-- The lookup happens BEFORE a transaction-local tenant GUC exists, so this table
-- deliberately has NO row level security: isolation is by grant. Grant SELECT to a
-- dedicated service identity role only - never to the runtime role or PUBLIC - and
-- keep provisioning (INSERT/UPDATE) with the migration role.
CREATE TABLE IF NOT EXISTS pi861_service_principals (
  principal_id text PRIMARY KEY,
  token_digest text NOT NULL UNIQUE,
  tenant_id text NOT NULL,
  read_scopes jsonb NOT NULL,
  write_scopes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disabled_at timestamptz
);
REVOKE ALL ON pi861_service_principals FROM PUBLIC;

-- Durable C3 budget authority: one row per budgetId holding the frozen contract
-- snapshot (TaskTreeBudget.exportState, version 2). Reserve/settle transactions load
-- the snapshot, run the contract logic and write the next snapshot under an advisory
-- lock plus store_version compare-and-set, so limits, conservative unknown usage and
-- probe single-flight are enforced atomically by the database.
CREATE TABLE IF NOT EXISTS pi861_budgets (
  tenant_id text NOT NULL,
  budget_id text NOT NULL,
  store_version bigint NOT NULL DEFAULT 0 CHECK (store_version >= 0),
  snapshot jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, budget_id)
);

-- Persistent C2 leases (integration workspaces, coordinator roles, distill claims).
-- Generation increments monotonically per acquire; a commit path revalidates the
-- generation (fencing) before accepting a result, so an expired lease can block a
-- receipt without stopping the running process itself.
CREATE TABLE IF NOT EXISTS pi861_leases (
  tenant_id text NOT NULL,
  purpose text NOT NULL,
  owner text NOT NULL,
  token text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1),
  acquired_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  lease_id text NOT NULL,
  PRIMARY KEY (tenant_id, purpose)
);

-- Row level security for the tenant-scoped service tables: same GUC boundary as the
-- memory tables; read and write both require the transaction-local tenant setting.
-- Scope GUCs are not used here: budgets and leases are task-tree resources, not
-- memory scopes; operation authorization is the authenticated service's job.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pi861_budgets', 'pi861_leases'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = t AND policyname = 'pi861_tenant') THEN
      EXECUTE format(
        'CREATE POLICY pi861_tenant ON %I USING
         (tenant_id = current_setting(''pi861.tenant_id'', true))
         WITH CHECK
         (tenant_id = current_setting(''pi861.tenant_id'', true))', t);
    END IF;
  END LOOP;
END $$;

COMMIT;
-- Operator provisioning (NOT executed here; the migration tool also refuses the
-- runtime role). Runtime role: SELECT/INSERT/UPDATE on pi861_budgets, pi861_leases
-- and DELETE on pi861_leases only. Service identity role: SELECT on
-- pi861_service_principals only, nothing else. Migration ledger entry ('storage-v4'
-- with this file's digest) is written by migrateStorage together with the backup
-- and the conflict report.
