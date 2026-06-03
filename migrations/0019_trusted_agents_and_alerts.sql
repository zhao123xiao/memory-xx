-- Migration 0019: trusted agent permissions and operational alert state.

CREATE TABLE IF NOT EXISTS trusted_agents (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  agent_id text NOT NULL,
  permissions text[] NOT NULL,
  scopes jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trusted_agents_active_token
  ON trusted_agents (token_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_trusted_agents_expiry
  ON trusted_agents (expires_at)
  WHERE revoked_at IS NULL AND expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_alerts (
  id text PRIMARY KEY,
  alert_key text NOT NULL UNIQUE,
  resource text NOT NULL,
  metric text NOT NULL,
  level text NOT NULL CHECK (level IN ('info', 'warning', 'critical')),
  value double precision,
  threshold double precision,
  status text NOT NULL CHECK (status IN ('open', 'recovered')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz,
  recovered_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_memory_alerts_status_seen
  ON memory_alerts (status, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_alerts_resource_metric
  ON memory_alerts (resource, metric, last_seen_at DESC);
