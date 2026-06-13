# Qdrant Collection Proxy

Small HTTP proxy that rewrites Qdrant collection names. It is useful for
blue/green collection testing or cutover drills while keeping callers pointed at
a stable endpoint.

Run:

```bash
MEMORY_XX_QDRANT_PROXY_FROM_COLLECTION=memory-xx \
MEMORY_XX_QDRANT_PROXY_TO_COLLECTION=memory-xx-active \
node sidecars/qdrant-proxy/qdrant-collection-proxy.mjs
```

Important environment variables:

| Variable | Purpose |
| --- | --- |
| `MEMORY_XX_QDRANT_PROXY_PORT` | Local proxy port, defaults to `6334` |
| `MEMORY_XX_QDRANT_PROXY_UPSTREAM` | Real Qdrant endpoint, defaults to `http://127.0.0.1:6333` |
| `MEMORY_XX_QDRANT_PROXY_FROM_COLLECTION` | Source collection name in incoming requests |
| `MEMORY_XX_QDRANT_PROXY_TO_COLLECTION` | Collection name sent upstream |
