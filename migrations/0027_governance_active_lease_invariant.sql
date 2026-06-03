CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_governance_runs_active_lease
  ON memory_governance_runs (job_type)
  WHERE lease_acquired_by IS NOT NULL;
