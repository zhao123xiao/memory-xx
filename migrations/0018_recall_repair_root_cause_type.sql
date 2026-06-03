-- Migration 0018: typed recall repair root-cause values for false-null automation.

ALTER TABLE recall_repair_queue
  ADD COLUMN IF NOT EXISTS root_cause_type text;

UPDATE recall_repair_queue
SET root_cause_type = root_cause
WHERE root_cause_type IS NULL
  AND root_cause IN (
    'projection_gap',
    'embedding_gap',
    'alias_missing',
    'scope_mismatch',
    'temporal_filter_too_strict',
    'memory_absent',
    'rerank_demoted'
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'recall_repair_queue_root_cause_type_check'
      AND conrelid = 'recall_repair_queue'::regclass
  ) THEN
    ALTER TABLE recall_repair_queue
      ADD CONSTRAINT recall_repair_queue_root_cause_type_check
      CHECK (
        root_cause_type IS NULL OR root_cause_type IN (
          'projection_gap',
          'embedding_gap',
          'alias_missing',
          'scope_mismatch',
          'temporal_filter_too_strict',
          'memory_absent',
          'rerank_demoted'
        )
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE recall_repair_queue
  VALIDATE CONSTRAINT recall_repair_queue_root_cause_type_check;

CREATE INDEX IF NOT EXISTS idx_recall_repair_queue_root_cause_type
  ON recall_repair_queue (root_cause_type, status, updated_at DESC);
