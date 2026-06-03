-- Migration 0006: Add temporal and layer fields to memory_records
-- All columns are nullable or have defaults for backward compatibility.
-- Existing records will be backfilled in 0009.

ALTER TABLE memory_records
  ADD COLUMN IF NOT EXISTS memory_layer text DEFAULT 'recall',
  ADD COLUMN IF NOT EXISTS fact_status text DEFAULT 'current',
  ADD COLUMN IF NOT EXISTS valid_at timestamptz,
  ADD COLUMN IF NOT EXISTS invalid_at timestamptz,
  ADD COLUMN IF NOT EXISTS observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS episode_id uuid,
  ADD COLUMN IF NOT EXISTS importance real DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS memory_strength real DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS decay_policy text DEFAULT 'importance_weighted';

-- Check constraints for new enum-like columns
ALTER TABLE memory_records
  DROP CONSTRAINT IF EXISTS chk_memory_records_memory_layer;
ALTER TABLE memory_records
  ADD CONSTRAINT chk_memory_records_memory_layer
  CHECK (memory_layer IN ('core', 'semantic', 'episodic', 'procedural', 'recall', 'archival', 'audit'));

ALTER TABLE memory_records
  DROP CONSTRAINT IF EXISTS chk_memory_records_fact_status;
ALTER TABLE memory_records
  ADD CONSTRAINT chk_memory_records_fact_status
  CHECK (fact_status IN ('current', 'historical', 'deprecated', 'resurrected'));

ALTER TABLE memory_records
  DROP CONSTRAINT IF EXISTS chk_memory_records_decay_policy;
ALTER TABLE memory_records
  ADD CONSTRAINT chk_memory_records_decay_policy
  CHECK (decay_policy IN ('none', 'time_based', 'access_based', 'importance_weighted'));

-- Indexes for temporal queries
CREATE INDEX IF NOT EXISTS idx_mr_memory_layer
  ON memory_records (memory_layer);
CREATE INDEX IF NOT EXISTS idx_mr_fact_status
  ON memory_records (fact_status);
CREATE INDEX IF NOT EXISTS idx_mr_valid_at
  ON memory_records (valid_at)
  WHERE valid_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mr_episode_id
  ON memory_records (episode_id)
  WHERE episode_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mr_importance
  ON memory_records (importance)
  WHERE importance IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mr_memory_strength
  ON memory_records (memory_strength)
  WHERE memory_strength IS NOT NULL;

-- Composite index for the most common recall query: current facts in recallable layers
CREATE INDEX IF NOT EXISTS idx_mr_layer_status_current
  ON memory_records (memory_layer, fact_status, updated_at DESC)
  WHERE is_current = true AND lifecycle_status IN ('approved', 'candidate');
