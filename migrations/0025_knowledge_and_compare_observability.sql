-- Migration 0025: knowledge-specific grants and intelligence compare observations.

CREATE TABLE IF NOT EXISTS knowledge_scope_grants (
  id text PRIMARY KEY,
  agent_id text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  permissions text[] NOT NULL,
  expires_at timestamptz,
  created_by text NOT NULL,
  revoked_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_scope_grants_resource_type_check
    CHECK (resource_type IN ('collection', 'repo')),
  CONSTRAINT knowledge_scope_grants_permissions_nonempty_check
    CHECK (array_length(permissions, 1) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_scope_grants_active_unique
  ON knowledge_scope_grants (agent_id, resource_type, resource_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_scope_grants_lookup
  ON knowledge_scope_grants (agent_id, resource_type, resource_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS intelligence_compare_observations (
  id text PRIMARY KEY,
  observed_at timestamptz NOT NULL,
  primary_model text NOT NULL,
  fallback_model text NOT NULL,
  primary_latency_ms integer NOT NULL CHECK (primary_latency_ms >= 0),
  fallback_latency_ms integer NOT NULL CHECK (fallback_latency_ms >= 0),
  primary_schema_valid boolean NOT NULL,
  fallback_schema_valid boolean NOT NULL,
  memory_count_diff integer NOT NULL CHECK (memory_count_diff >= 0),
  confidence_diff double precision NOT NULL CHECK (confidence_diff >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intelligence_compare_observations_observed_at
  ON intelligence_compare_observations (observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_intelligence_compare_observations_diff
  ON intelligence_compare_observations (memory_count_diff, confidence_diff, observed_at DESC);
