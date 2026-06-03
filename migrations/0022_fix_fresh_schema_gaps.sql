-- Migration 0022: Fix fresh schema gaps and CHECK constraints
-- Adds missing columns, drops legacy constraints, fixes CHECK constraints
-- for write path hardening commands and feedback types.

-- ============================================================
-- 1. Missing columns on memory_records
-- ============================================================
ALTER TABLE memory_records
  ADD COLUMN IF NOT EXISTS usage_count integer DEFAULT 0;

ALTER TABLE memory_records
  ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz;

ALTER TABLE memory_records
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE memory_records
  ADD COLUMN IF NOT EXISTS source_kind text;

ALTER TABLE memory_records
  ADD COLUMN IF NOT EXISTS source_ref text;

ALTER TABLE memory_records
  ADD COLUMN IF NOT EXISTS legacy_memory_id text;

-- ============================================================
-- 2. Drop legacy constraint (may exist only on live DBs)
-- ============================================================
ALTER TABLE memory_records
  DROP CONSTRAINT IF EXISTS memory_records_review_next_chk;

-- ============================================================
-- 3. Fix ingest_requests.command_type CHECK — add memory.candidate.update
-- ============================================================
ALTER TABLE ingest_requests
  DROP CONSTRAINT IF EXISTS ingest_requests_command_type_check;

ALTER TABLE ingest_requests
  ADD CONSTRAINT ingest_requests_command_type_check
  CHECK (command_type IN (
    'memory.create',
    'memory.approve',
    'memory.reject',
    'memory.archive',
    'memory.supersede',
    'memory.tombstone',
    'memory.candidate.update'
  ));

-- ============================================================
-- 4. Fix memory_events.event_type CHECK — add memory.candidate.updated
-- ============================================================
ALTER TABLE memory_events
  DROP CONSTRAINT IF EXISTS memory_events_event_type_check;

ALTER TABLE memory_events
  ADD CONSTRAINT memory_events_event_type_check
  CHECK (event_type IN (
    'memory.created',
    'memory.updated',
    'memory.lifecycle.changed',
    'memory.review.changed',
    'memory.superseded',
    'memory.tombstoned',
    'memory.relation.changed',
    'memory.source.changed',
    'memory.embedding.refreshed',
    'projection.rebuild.requested',
    'migration.shadow.loaded',
    'cache.invalidate.requested',
    'memory.candidate.updated'
  ));

-- ============================================================
-- 5. Fix outbox_events.event_type CHECK — add memory.candidate.updated
-- ============================================================
ALTER TABLE outbox_events
  DROP CONSTRAINT IF EXISTS outbox_events_event_type_check;

ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_event_type_check
  CHECK (event_type IN (
    'memory.created',
    'memory.updated',
    'memory.lifecycle.changed',
    'memory.review.changed',
    'memory.superseded',
    'memory.tombstoned',
    'memory.relation.changed',
    'memory.source.changed',
    'memory.embedding.refreshed',
    'projection.rebuild.requested',
    'migration.shadow.loaded',
    'cache.invalidate.requested',
    'memory.candidate.updated'
  ));

-- ============================================================
-- 6. Fix memory_feedback_events.feedback_type CHECK — add negative
-- ============================================================
ALTER TABLE memory_feedback_events
  DROP CONSTRAINT IF EXISTS memory_feedback_events_feedback_type_check;

ALTER TABLE memory_feedback_events
  ADD CONSTRAINT memory_feedback_events_feedback_type_check
  CHECK (feedback_type IN (
    'confirmed',
    'used',
    'edited',
    'wrong',
    'deleted',
    'not_relevant',
    'changed_mind',
    'negative'
  ));
