-- Migration 0016: governance control-loop state for write/recall/projection consistency.

CREATE TABLE IF NOT EXISTS memory_governance_runs (
  id text PRIMARY KEY,
  job_type text NOT NULL,
  mode text NOT NULL DEFAULT 'report-only',
  policy text,
  status text NOT NULL CHECK (status IN ('running', 'success', 'failed', 'skipped_lock_held', 'partial')),
  lock_key text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_governance_runs_job_started
  ON memory_governance_runs (job_type, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_governance_runs_status_started
  ON memory_governance_runs (status, started_at DESC);

CREATE TABLE IF NOT EXISTS memory_governance_actions (
  id text PRIMARY KEY,
  run_id text REFERENCES memory_governance_runs(id) ON DELETE SET NULL,
  action_type text NOT NULL,
  scope_type text,
  scope_id text,
  memory_id text REFERENCES memory_records(id) ON DELETE SET NULL,
  related_memory_id text REFERENCES memory_records(id) ON DELETE SET NULL,
  selector jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  before_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  outbox_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  revert_token_hash text,
  revert_expires_at timestamptz,
  reverted_at timestamptz,
  status text NOT NULL DEFAULT 'reported' CHECK (status IN ('reported', 'applied', 'skipped', 'reverted', 'failed')),
  created_by text NOT NULL DEFAULT 'memory-governance',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_governance_actions_run
  ON memory_governance_actions (run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_governance_actions_memory
  ON memory_governance_actions (memory_id, created_at DESC)
  WHERE memory_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_governance_actions_revert
  ON memory_governance_actions (revert_token_hash)
  WHERE revert_token_hash IS NOT NULL AND reverted_at IS NULL;

CREATE TABLE IF NOT EXISTS memory_governance_freezes (
  id text PRIMARY KEY,
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  actions text[] NOT NULL DEFAULT ARRAY[]::text[],
  reason text NOT NULL,
  actor_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  lifted_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_memory_governance_freezes_active_scope
  ON memory_governance_freezes (scope_type, scope_id, expires_at)
  WHERE lifted_at IS NULL;

CREATE TABLE IF NOT EXISTS governance_policy_overrides (
  id text PRIMARY KEY,
  selector_hash text NOT NULL UNIQUE,
  selector jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_type text NOT NULL,
  threshold double precision,
  default_threshold double precision,
  auto_approve_enabled boolean,
  clean_run_count integer NOT NULL DEFAULT 0,
  last_cohort_at timestamptz,
  expires_at timestamptz NOT NULL,
  reviewed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_governance_policy_overrides_policy_expiry
  ON governance_policy_overrides (policy_type, expires_at);

ALTER TABLE recall_repair_queue
  ADD COLUMN IF NOT EXISTS urgency text NOT NULL DEFAULT 'P2',
  ADD COLUMN IF NOT EXISTS root_cause text,
  ADD COLUMN IF NOT EXISTS suggested_action text,
  ADD COLUMN IF NOT EXISTS governance_action_id text REFERENCES memory_governance_actions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS applied_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_recall_repair_queue_urgency_status
  ON recall_repair_queue (status, urgency, updated_at DESC);
