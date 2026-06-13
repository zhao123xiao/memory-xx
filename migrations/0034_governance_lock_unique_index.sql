-- Ensure only one running governance job per job type can exist.

CREATE UNIQUE INDEX IF NOT EXISTS uq_governance_runs_active_job
  ON memory_governance_runs (job_type)
  WHERE status = 'running';
