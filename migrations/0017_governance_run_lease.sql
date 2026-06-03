-- Migration 0017: add durable governance worker lease state.

ALTER TABLE memory_governance_runs
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_acquired_by text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_governance_runs_active_lease
  ON memory_governance_runs (job_type)
  WHERE lease_acquired_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_governance_runs_lease_expiry
  ON memory_governance_runs (job_type, lease_expires_at)
  WHERE lease_acquired_by IS NOT NULL;
