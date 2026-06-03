-- Add a first-class recall-feedback command type for idempotent recall feedback writes.

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
    'memory.candidate.update',
    'recall.feedback'
  ));
