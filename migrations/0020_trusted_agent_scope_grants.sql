-- Migration 0020: strict-mode trusted agent scope grants.
--
-- 0017_governance_run_lease.sql and 0017_scope_generations.sql are already
-- applied in some local instances, so they remain registered as historical
-- duplicate-prefix exceptions. New migrations must use unique numeric prefixes.

CREATE TABLE IF NOT EXISTS trusted_agent_scope_grants (
  id text PRIMARY KEY,
  agent_id text NOT NULL,
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  permissions text[] NOT NULL,
  expires_at timestamptz,
  created_by text NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trusted_agent_scope_grants_scope_type_check
    CHECK (scope_type IN ('user', 'project', 'workspace', 'global')),
  CONSTRAINT trusted_agent_scope_grants_permissions_nonempty_check
    CHECK (array_length(permissions, 1) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trusted_agent_scope_grants_active_unique
  ON trusted_agent_scope_grants (agent_id, scope_type, scope_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_trusted_agent_scope_grants_lookup
  ON trusted_agent_scope_grants (agent_id, scope_type, scope_id, expires_at)
  WHERE revoked_at IS NULL;
