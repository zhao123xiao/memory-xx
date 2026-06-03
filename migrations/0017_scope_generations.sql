-- Migration 0017: scope generation ledger for recall cache invalidation.

CREATE TABLE IF NOT EXISTS scope_generations (
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  generation bigint NOT NULL DEFAULT 0,
  bumped_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, scope_id)
);
