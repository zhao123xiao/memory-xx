# api

Frozen path for `/api/memory/v2/*` handlers and request contracts.

Current implemented route slices stay intentionally narrow:

- `/api/memory/v2/write/*` for create-memory
- `/api/memory/v2/review/*` for review/lifecycle governance writes
- `/api/memory/v2/recall/*` for the frozen read-chain skeleton

Phase C2 still does not widen into projection or ops handlers.
