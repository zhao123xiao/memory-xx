CREATE TABLE IF NOT EXISTS runtime_snapshots (
  snapshot_id text PRIMARY KEY,
  collected_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'unknown',
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  registry jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_runtime_snapshots_collected_at
  ON runtime_snapshots (collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_runtime_snapshots_status
  ON runtime_snapshots (status, collected_at DESC);

