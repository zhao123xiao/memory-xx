# coordination

Redis-backed coordination foundation for `memory-xx`.

Current Phase B4 code intentionally stops at:

- frozen coordination constants, task models, keys, and error types
- explicit ports for queue, lease, lock, fencing, generation, runtime context,
  presence, single-flight, idempotency, and dedupe
- in-memory fake implementations for tests without introducing a real Redis
  client dependency
- worker and recovery skeletons for claim, renew, release, DLQ, replay, lease
  recovery, and presence sweeping

Current Phase C5 adds a minimal executable runtime chain:

- outbox/control-event dispatcher with idempotent consume semantics
- scope/vector generation bump planning from outbox event types
- default runtime handlers for `cache.invalidate` and `projection.export`
- runtime scope adapter that exposes Redis-like TTL `run/task` context to Recall
- in-memory runtime factory that stitches dispatcher, queue, worker, and sweeper

What this module does not do:

- it does not treat Redis as a long-term source of truth
- it does not persist canonical memory facts outside PostgreSQL + outbox
- it does not write `run/task` runtime scope back into long-term scope
