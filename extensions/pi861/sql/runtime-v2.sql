-- Operator migration, not run automatically on a user's database.
BEGIN;
CREATE TABLE IF NOT EXISTS pi861_runtime_state (
  tenant_id text NOT NULL,
  state_key text NOT NULL,
  body jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,state_key)
);
ALTER TABLE pi861_runtime_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE pi861_runtime_state FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='pi861_runtime_state' AND policyname='pi861_runtime_tenant') THEN
    CREATE POLICY pi861_runtime_tenant ON pi861_runtime_state
      USING (tenant_id=current_setting('pi861.tenant_id',true))
      WITH CHECK (tenant_id=current_setting('pi861.tenant_id',true));
  END IF;
END $$;
COMMIT;
-- Grant SELECT/INSERT/UPDATE only to the trusted coordinator/memory service role.
-- Per-caller project/role authorization remains the service responsibility.
