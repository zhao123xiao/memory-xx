-- Migration 0015: recall trace, feedback, repair queue, and recall-degrade audit state.

CREATE TABLE IF NOT EXISTS recall_traces (
  id text PRIMARY KEY,
  query_hash text NOT NULL,
  query_excerpt text NOT NULL,
  actor_id text,
  scope_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  query_type text NOT NULL,
  strategy text NOT NULL,
  degrade_level integer NOT NULL DEFAULT 0 CHECK (degrade_level BETWEEN 0 AND 3),
  results jsonb NOT NULL DEFAULT '{}'::jsonb,
  audit jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recall_traces_query_hash_created
  ON recall_traces (query_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_recall_traces_actor_created
  ON recall_traces (actor_id, created_at DESC)
  WHERE actor_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS recall_feedback_events (
  id text PRIMARY KEY,
  recall_trace_id text NOT NULL REFERENCES recall_traces(id) ON DELETE CASCADE,
  memory_id text,
  actor_id text NOT NULL,
  feedback_type text NOT NULL CHECK (
    feedback_type IN ('presented', 'used_in_context', 'adopted', 'ignored', 'not_relevant', 'false_positive', 'false_null')
  ),
  suspicious boolean NOT NULL DEFAULT false,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recall_feedback_events_trace
  ON recall_feedback_events (recall_trace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_recall_feedback_events_actor
  ON recall_feedback_events (actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS recall_repair_queue (
  id text PRIMARY KEY,
  query_hash text NOT NULL,
  recall_trace_id text REFERENCES recall_traces(id) ON DELETE SET NULL,
  issue_type text NOT NULL CHECK (
    issue_type IN ('false_null', 'ignored', 'not_relevant', 'reranker_fallback')
  ),
  count integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'suggested', 'dismissed', 'applied')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (query_hash, issue_type)
);

CREATE INDEX IF NOT EXISTS idx_recall_repair_queue_status_count
  ON recall_repair_queue (status, count DESC, updated_at DESC);
