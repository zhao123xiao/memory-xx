-- Migration 0008: Expand memory_relations with metadata and new relation types

-- Add metadata column for extended relation attributes
ALTER TABLE memory_relations
  ADD COLUMN IF NOT EXISTS relation_metadata jsonb DEFAULT '{}'::jsonb;

-- Relation types are stored as text in the existing relation_type column.
-- New supported types: supersedes, contradicts, supports, derived_from, same_as
-- These coexist with any existing relation_type values. No constraint change needed
-- since relation_type is already text without a CHECK constraint.
