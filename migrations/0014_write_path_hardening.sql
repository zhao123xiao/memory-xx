-- Migration 0014: write-path hardening state for session/quality/ticket/projection feedback.

ALTER TABLE memory_records
  DROP CONSTRAINT IF EXISTS memory_records_review_state_check;

ALTER TABLE memory_records
  ADD CONSTRAINT memory_records_review_state_check
  CHECK (review_state IN ('pending', 'approved', 'silent_approved', 'not_required', 'rejected'));

DROP INDEX IF EXISTS idx_memory_records_effective_recallable;
CREATE INDEX idx_memory_records_effective_recallable
  ON memory_records (scope_type, scope_id, updated_at DESC)
  WHERE lifecycle_status = 'approved'
    AND is_current = TRUE
    AND review_state IN ('approved', 'silent_approved', 'not_required');

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS dispatched_by text,
  ADD COLUMN IF NOT EXISTS dispatch_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS projection_verified boolean,
  ADD COLUMN IF NOT EXISTS dispatch_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS low_confidence_buffer (
  id text PRIMARY KEY,
  request_id text NOT NULL,
  actor_id text NOT NULL,
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  input_text text NOT NULL,
  extraction jsonb NOT NULL DEFAULT '{}'::jsonb,
  quality_gate jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('pending_retry', 'retried', 'promoted', 'abandoned')),
  retry_count integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  abandoned_at timestamptz,
  promoted_memory_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_low_confidence_buffer_retry
  ON low_confidence_buffer (status, next_retry_at)
  WHERE status = 'pending_retry';

CREATE TABLE IF NOT EXISTS write_tickets (
  id text PRIMARY KEY,
  idempotency_key text UNIQUE,
  actor_id text NOT NULL,
  agent_id text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('pending_extraction', 'completed', 'skipped_duplicate', 'needs_review', 'cancelled_low_quality', 'failed_extraction')
  ),
  request_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_json jsonb,
  created_memory_id text,
  candidate_memory_id text,
  duplicate_of_memory_id text,
  failure_reason text,
  expires_at timestamptz NOT NULL,
  terminal_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_write_tickets_status_expires
  ON write_tickets (status, expires_at);

CREATE INDEX IF NOT EXISTS idx_write_tickets_terminal
  ON write_tickets (terminal_at)
  WHERE terminal_at IS NOT NULL AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS write_tickets_archive (LIKE write_tickets INCLUDING ALL);

CREATE TABLE IF NOT EXISTS memory_feedback_events (
  id text PRIMARY KEY,
  memory_id text NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  feedback_type text NOT NULL CHECK (
    feedback_type IN ('confirmed', 'used', 'edited', 'wrong', 'deleted', 'not_relevant', 'changed_mind')
  ),
  related_memory_id text REFERENCES memory_records(id) ON DELETE SET NULL,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_feedback_events_memory
  ON memory_feedback_events (memory_id, created_at DESC);
