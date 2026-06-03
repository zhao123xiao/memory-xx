-- Conversation listener event spool and batch extraction audit.

CREATE TABLE IF NOT EXISTS conversation_events (
  id text PRIMARY KEY,
  conversation_id text NOT NULL,
  session_id text,
  turn_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content text NOT NULL,
  agent_id text NOT NULL,
  source text NOT NULL,
  scope_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  batch_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_events_identity_idx
  ON conversation_events (conversation_id, COALESCE(session_id, ''), turn_id, content_hash);

CREATE INDEX IF NOT EXISTS conversation_events_unprocessed_idx
  ON conversation_events (processed_at, conversation_id, session_id, observed_at)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS conversation_events_session_idx
  ON conversation_events (conversation_id, session_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS conversation_events_batch_idx
  ON conversation_events (batch_id)
  WHERE batch_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversation_batches (
  id text PRIMARY KEY,
  conversation_id text NOT NULL,
  session_id text,
  batch_hash text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'skipped')),
  agent_id text NOT NULL,
  source text NOT NULL,
  scope_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  messages_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  extraction_backend text,
  mem0_mode text,
  candidate_memory_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  no_op_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  retry_count integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_batches_session_idx
  ON conversation_batches (conversation_id, session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS conversation_batches_status_idx
  ON conversation_batches (status, created_at DESC);
