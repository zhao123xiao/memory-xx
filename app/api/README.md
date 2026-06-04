# api

Frozen path for `/api/memory/xx/*` handlers and request contracts.

Current implemented route slices stay intentionally narrow:

- `/api/memory/xx/write/*` for create-memory
- `/api/memory/xx/review/*` for review/lifecycle governance writes
- `/api/memory/xx/recall/*` for the frozen read-chain skeleton

Phase C2 still does not widen into projection or ops handlers.
