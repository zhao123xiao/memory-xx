-- Migration 0030: first-class audit trail for automatic approval decisions.

CREATE TABLE IF NOT EXISTS auto_approval_decisions (
  id text PRIMARY KEY,
  candidate_memory_id text REFERENCES memory_records(id) ON DELETE SET NULL,
  decision text NOT NULL CHECK (decision IN ('approve', 'pending', 'reject', 'buffer')),
  policy_version text NOT NULL,
  score double precision NOT NULL,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  blocked_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  agent_id text NOT NULL,
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  approved_memory_id text REFERENCES memory_records(id) ON DELETE SET NULL,
  rollback_memory_event_id text REFERENCES memory_events(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auto_approval_decisions_created
  ON auto_approval_decisions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auto_approval_decisions_scope
  ON auto_approval_decisions (scope_type, scope_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auto_approval_decisions_memory
  ON auto_approval_decisions (approved_memory_id, candidate_memory_id, created_at DESC);
