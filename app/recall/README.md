# recall

Single long-term Recall entry path for `memory-xx`.

Phase C3 recall now includes:
- Recall request/response DTOs and error codes
- rule-based query classifier
- scope resolution with runtime scope adapter boundary
- canonical `filter_mode=default => effective_recallable`
- metadata constraint builder
- runnable in-memory stubs plus PostgreSQL-backed lexical/vector retrievers
- PostgreSQL FTS lexical search with ILIKE fallback
- pgvector-ready capability probe and explicit vector degrade reasons
- hybrid planner, merge, minimal rerank, and structured explain/audit output
- `createPostgresRecallRuntime()` for shared-pool orchestration

Still deferred:
- audit sink persistence
- runtime cache generation and Redis coordination internals
- full embedding pipeline and schema-owned vector column rollout
- ranking policy beyond the current minimal rerank
