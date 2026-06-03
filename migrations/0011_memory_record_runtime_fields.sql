-- Migration 0011: Add runtime identity and governance fields used by current write code.
-- Older dumps can already contain these columns; fresh migrations need them too.

ALTER TABLE memory_records
  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS agent_id text NOT NULL DEFAULT 'main',
  ADD COLUMN IF NOT EXISTS governance_status text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'scope_only',
  ADD COLUMN IF NOT EXISTS memory_type text;

CREATE INDEX IF NOT EXISTS idx_memory_records_tenant_agent
  ON memory_records (tenant_id, agent_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_records_memory_type
  ON memory_records (memory_type)
  WHERE memory_type IS NOT NULL;
