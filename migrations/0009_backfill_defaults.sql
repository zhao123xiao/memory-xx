-- Migration 0009: Backfill existing records with temporal defaults

UPDATE memory_records
SET
  memory_layer = 'recall',
  fact_status = 'current',
  importance = 0.5,
  memory_strength = 1.0,
  decay_policy = 'importance_weighted'
WHERE memory_layer IS NULL
   OR fact_status IS NULL
   OR importance IS NULL
   OR memory_strength IS NULL
   OR decay_policy IS NULL;
