# Embedding Proxy

OpenAI-compatible embedding proxy used by memory-xx to add throttling, retries,
deduplication, queue budgeting, and a short in-memory response cache.

Run:

```bash
MEMORY_XX_EMBEDDING_PROXY_UPSTREAM_BASE=http://127.0.0.1:8082/v3 \
OPENAI_API_KEY=<set-private-key> \
node sidecars/embedding-proxy/embedding-proxy.mjs
```

Important environment variables:

| Variable | Purpose |
| --- | --- |
| `MEMORY_XX_EMBEDDING_PROXY_PORT` | Local proxy port, defaults to `5221` |
| `MEMORY_XX_EMBEDDING_PROXY_UPSTREAM_BASE` | Upstream OpenAI-compatible base URL |
| `MEMORY_XX_EMBEDDING_PROXY_UPSTREAM_MODEL` | Optional model override |
| `MEMORY_XX_EMBEDDING_PROXY_UPSTREAM_API_KEY` | Optional dedicated API key |
| `OPENAI_API_KEY` | Default OpenAI-compatible API key |

Legacy short `EMBEDDING_PROXY_*` names are accepted for local experiments, but
public memory-xx deployments should prefer `MEMORY_XX_*`.
