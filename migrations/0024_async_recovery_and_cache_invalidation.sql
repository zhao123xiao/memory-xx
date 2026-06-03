-- Migration 0024: async write recovery leases and durable cache invalidation compensation.

ALTER TABLE ingest_requests
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS recoverable_after timestamptz,
  ADD COLUMN IF NOT EXISTS recoverable boolean NOT NULL DEFAULT false;

ALTER TABLE memory_records
  ADD COLUMN IF NOT EXISTS embedding_generation text;

CREATE INDEX IF NOT EXISTS idx_ingest_requests_accepted_lease
  ON ingest_requests (status, lease_expires_at)
  WHERE status = 'accepted';

ALTER TABLE write_tickets
  DROP CONSTRAINT IF EXISTS write_tickets_status_check;

ALTER TABLE write_tickets
  ADD CONSTRAINT write_tickets_status_check
  CHECK (
    status IN (
      'pending_extraction',
      'processing_extraction',
      'completed',
      'skipped_duplicate',
      'needs_review',
      'cancelled_low_quality',
      'failed_extraction'
    )
  );

ALTER TABLE write_tickets
  ADD COLUMN IF NOT EXISTS payload_hash text,
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

ALTER TABLE write_tickets_archive
  ADD COLUMN IF NOT EXISTS payload_hash text,
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_write_tickets_worker_claim
  ON write_tickets (status, next_attempt_at, lease_expires_at, created_at)
  WHERE terminal_at IS NULL;

CREATE TABLE IF NOT EXISTS cache_invalidation_requests (
  id text PRIMARY KEY,
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  last_error text,
  lease_owner text,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cache_invalidation_requests_claim
  ON cache_invalidation_requests (status, next_attempt_at, lease_expires_at, created_at)
  WHERE completed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cache_invalidation_requests_scope
  ON cache_invalidation_requests (scope_type, scope_id, created_at DESC);
