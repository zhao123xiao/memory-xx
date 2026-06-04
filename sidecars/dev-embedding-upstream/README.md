# Dev Embedding Upstream

Deterministic OpenAI-compatible embedding endpoint for local smoke tests. It is
not a production embedding model and should not be used for quality evaluation.

Run:

```bash
MEMORY_XX_DEV_EMBEDDING_DIMS=384 \
node sidecars/dev-embedding-upstream/dev-embedding-upstream.mjs
```

Endpoints:

- `GET /health`
- `POST /v1/embeddings`
- `POST /embeddings`

Use it when you need to verify memory-xx Core wiring before configuring a real
local or remote embedding provider.
