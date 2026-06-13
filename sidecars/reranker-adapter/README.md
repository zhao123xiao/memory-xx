# Reranker Adapter

OpenAI-compatible reranker adapter for memory-xx recall enhancement. When this
module is disabled or unavailable, recall should continue with local rank
fusion.

Run:

```bash
MEMORY_XX_RERANKER_DOWNSTREAM_URL=http://127.0.0.1:8084/v3/rerank \
MEMORY_XX_RERANKER_DOWNSTREAM_MODELS_URL=http://127.0.0.1:8084/v3/models \
node sidecars/reranker-adapter/reranker-adapter.mjs
```

Important environment variables:

| Variable | Purpose |
| --- | --- |
| `MEMORY_XX_RERANKER_ADAPTER_PORT` | Local adapter port, defaults to `8085` |
| `MEMORY_XX_RERANKER_DOWNSTREAM_URL` | Upstream rerank endpoint |
| `MEMORY_XX_RERANKER_DOWNSTREAM_MODELS_URL` | Upstream model health endpoint |
| `MEMORY_XX_RERANKER_ADAPTER_TIMEOUT_MS` | Downstream request timeout |
