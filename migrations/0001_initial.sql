CREATE TABLE ingest_requests (
  request_id TEXT PRIMARY KEY,
  command_type TEXT NOT NULL CHECK (command_type IN ('memory.create')),
  payload_hash TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'completed', 'failed')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NULL,
  result_json JSONB NULL,
  error_code TEXT NULL,
  error_message TEXT NULL
);

CREATE TABLE memory_records (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES ingest_requests(request_id),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'project', 'workspace', 'global')),
  scope_id TEXT NOT NULL,
  content TEXT NOT NULL,
  title TEXT NULL,
  summary TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key TEXT NULL,
  lifecycle_status TEXT NOT NULL CHECK (
    lifecycle_status IN ('candidate', 'approved', 'rejected', 'archived', 'superseded', 'tombstone')
  ),
  review_state TEXT NOT NULL CHECK (
    review_state IN ('pending', 'approved', 'not_required', 'rejected')
  ),
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE memory_sources (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  uri TEXT NULL,
  excerpt TEXT NULL,
  confidence DOUBLE PRECISION NULL,
  captured_at TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE memory_relations (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  related_memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE RESTRICT,
  relation_type TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('outbound', 'bidirectional')),
  weight DOUBLE PRECISION NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE memory_events (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES ingest_requests(request_id),
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'memory.created',
      'memory.updated',
      'memory.lifecycle.changed',
      'memory.review.changed',
      'memory.superseded',
      'memory.tombstoned',
      'memory.relation.changed',
      'memory.source.changed',
      'memory.embedding.refreshed',
      'projection.rebuild.requested',
      'migration.shadow.loaded',
      'cache.invalidate.requested'
    )
  ),
  actor_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY,
  aggregate_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES ingest_requests(request_id),
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'memory.created',
      'memory.updated',
      'memory.lifecycle.changed',
      'memory.review.changed',
      'memory.superseded',
      'memory.tombstoned',
      'memory.relation.changed',
      'memory.source.changed',
      'memory.embedding.refreshed',
      'projection.rebuild.requested',
      'migration.shadow.loaded',
      'cache.invalidate.requested'
    )
  ),
  payload JSONB NOT NULL,
  payload_version INTEGER NOT NULL DEFAULT 1,
  dispatch_status TEXT NOT NULL CHECK (dispatch_status IN ('pending', 'dispatched', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatched_at TIMESTAMPTZ NULL
);

CREATE TABLE migration_audit (
  id TEXT PRIMARY KEY,
  request_id TEXT NULL REFERENCES ingest_requests(request_id),
  target_table TEXT NOT NULL,
  target_id TEXT NOT NULL,
  batch_id TEXT NULL,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE exporter_state (
  exporter_name TEXT PRIMARY KEY,
  last_successful_event_id TEXT NULL,
  cursor TEXT NULL,
  last_success_at TIMESTAMPTZ NULL,
  failure_summary TEXT NULL,
  is_rebuilding BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_memory_records_effective_recallable
  ON memory_records (scope_type, scope_id, updated_at DESC)
  WHERE lifecycle_status = 'approved'
    AND is_current = TRUE
    AND review_state IN ('approved', 'not_required');

CREATE INDEX idx_memory_events_request_id ON memory_events (request_id, created_at DESC);
CREATE INDEX idx_outbox_events_dispatch_status ON outbox_events (dispatch_status, created_at ASC);
CREATE INDEX idx_migration_audit_batch_id ON migration_audit (batch_id, created_at DESC);
