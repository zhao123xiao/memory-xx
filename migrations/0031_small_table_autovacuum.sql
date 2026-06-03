-- Migration 0031: tune autovacuum for small high-churn tables.
--
-- These tables are small enough that the PostgreSQL defaults can leave a high
-- dead-tuple ratio for a long time. Lower per-table thresholds keep statistics
-- and dead tuple cleanup responsive without changing global PostgreSQL config.

ALTER TABLE IF EXISTS memory_embedding_generations SET (
  autovacuum_vacuum_threshold = 10,
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_threshold = 10,
  autovacuum_analyze_scale_factor = 0.05
);

ALTER TABLE IF EXISTS conversation_events SET (
  autovacuum_vacuum_threshold = 10,
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_threshold = 10,
  autovacuum_analyze_scale_factor = 0.05
);

ALTER TABLE IF EXISTS governance_policy_overrides SET (
  autovacuum_vacuum_threshold = 10,
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_threshold = 10,
  autovacuum_analyze_scale_factor = 0.05
);

ALTER TABLE IF EXISTS exporter_state SET (
  autovacuum_vacuum_threshold = 10,
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_threshold = 10,
  autovacuum_analyze_scale_factor = 0.05
);

ALTER TABLE IF EXISTS recall_feedback_events SET (
  autovacuum_vacuum_threshold = 10,
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_threshold = 10,
  autovacuum_analyze_scale_factor = 0.05
);

ALTER TABLE IF EXISTS scope_generations SET (
  autovacuum_vacuum_threshold = 10,
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_threshold = 10,
  autovacuum_analyze_scale_factor = 0.05
);

ALTER TABLE IF EXISTS memory_governance_actions SET (
  autovacuum_vacuum_threshold = 10,
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_threshold = 10,
  autovacuum_analyze_scale_factor = 0.05
);
