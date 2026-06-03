CREATE TABLE IF NOT EXISTS memory_embedding_generations (
  generation_id text PRIMARY KEY,
  provider text NOT NULL,
  model text NOT NULL,
  precision text NOT NULL,
  dims integer NOT NULL CHECK (dims > 0),
  embedding_base_hash text,
  text_strategy text NOT NULL,
  source_collection text,
  target_collection text NOT NULL,
  qdrant_alias text NOT NULL,
  redis_prefix text NOT NULL,
  query_cache_version text NOT NULL,
  record_count integer NOT NULL DEFAULT 0 CHECK (record_count >= 0),
  point_count integer NOT NULL DEFAULT 0 CHECK (point_count >= 0),
  payload_sample_verified boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('prepared', 'generated', 'validated', 'active', 'retired', 'failed')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  retired_at timestamptz,
  failed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_embedding_generations_one_active
  ON memory_embedding_generations ((status))
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_memory_embedding_generations_status_updated
  ON memory_embedding_generations (status, updated_at DESC);

