-- Migration 0007: Create episodes, entities, and entity_links tables

CREATE TABLE IF NOT EXISTS memory_episodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  occurred_at timestamptz,
  ended_at timestamptz,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  name text NOT NULL,
  canonical_name text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_entity_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
  memory_id text NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  role text DEFAULT 'subject',
  confidence real DEFAULT 1.0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_entity_links_entity
  ON memory_entity_links (entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_links_memory
  ON memory_entity_links (memory_id);
CREATE INDEX IF NOT EXISTS idx_entities_type
  ON memory_entities (entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_name
  ON memory_entities (name);
CREATE INDEX IF NOT EXISTS idx_episodes_occurred
  ON memory_episodes (occurred_at DESC)
  WHERE occurred_at IS NOT NULL;
