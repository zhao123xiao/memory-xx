-- Add a first-class ordinary feedback command/event path.

ALTER TABLE ingest_requests
  DROP CONSTRAINT IF EXISTS ingest_requests_command_type_check;

ALTER TABLE ingest_requests
  ADD CONSTRAINT ingest_requests_command_type_check
  CHECK (command_type IN (
    'memory.create',
    'memory.feedback',
    'memory.approve',
    'memory.reject',
    'memory.archive',
    'memory.supersede',
    'memory.tombstone',
    'memory.candidate.update'
  ));

ALTER TABLE memory_events
  DROP CONSTRAINT IF EXISTS memory_events_event_type_check;

ALTER TABLE memory_events
  ADD CONSTRAINT memory_events_event_type_check
  CHECK (event_type IN (
    'memory.created',
    'memory.updated',
    'memory.feedback.recorded',
    'memory.lifecycle.changed',
    'memory.review.changed',
    'memory.superseded',
    'memory.tombstoned',
    'memory.relation.changed',
    'memory.source.changed',
    'memory.embedding.refreshed',
    'projection.rebuild.requested',
    'migration.shadow.loaded',
    'cache.invalidate.requested',
    'memory.candidate.updated'
  ));

ALTER TABLE outbox_events
  DROP CONSTRAINT IF EXISTS outbox_events_event_type_check;

ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_event_type_check
  CHECK (event_type IN (
    'memory.created',
    'memory.updated',
    'memory.feedback.recorded',
    'memory.lifecycle.changed',
    'memory.review.changed',
    'memory.superseded',
    'memory.tombstoned',
    'memory.relation.changed',
    'memory.source.changed',
    'memory.embedding.refreshed',
    'projection.rebuild.requested',
    'migration.shadow.loaded',
    'cache.invalidate.requested',
    'memory.candidate.updated'
  ));
