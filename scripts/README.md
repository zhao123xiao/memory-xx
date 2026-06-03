# scripts

`migrate.ts` is the current C1 helper entrypoint for applying SQL migrations
through the real PostgreSQL adapter configuration.

`run-qdrant-projector-worker.ts` is the minimal runner/daemon entrypoint for the
Qdrant projector worker loop. It now performs a startup self-check and writes a
JSON health/status snapshot to `MEMORY_V2_QDRANT_PROJECTOR_STATUS_FILE`
(default: `services/memory-xx/qdrant-projector-worker.status.json`).

`check-qdrant-projector-worker-health.ts` is the read-only health probe for the
Qdrant projector worker. It reads `qdrant-projector-worker.status.json`, checks
`systemctl --user show memory-xx-qdrant-projector-worker.service`, and prints a
clear `OK` / `FAIL` summary plus JSON diagnostics. It does not mutate service
state, status files, database rows, or outbox state.

`replay-qdrant-outbox.ts` is the manual replay/repair entrypoint for
Qdrant sync. It supports three mutually exclusive modes:
- explicit `--event-id` replay
- bounded `--exporter-name ... --status failed|pending --limit N` batch replay
- direct `--memory-id` repair for a single memory

By default it only re-syncs affected memory ids and does not change
outbox/cursor state. In `--memory-id` mode it always stays non-destructive and
calls `QdrantProjectionSyncService.syncMemoryIds([memoryId])` directly. If the
record is missing `content_embedding`, the repair path uses the configured local
embedding provider and writes the embedding back before Qdrant upsert. Add
`--mark-dispatched` only when you explicitly want to advance exporter state for
successful `--event-id` / `--exporter-name` replay(s).
