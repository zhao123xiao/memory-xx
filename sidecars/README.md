# memory-xx Sidecars

`sidecars/` contains optional modules from the memory-xx full stack. The wrapper
must keep working when an optional sidecar is disabled or degraded.

## Included Source

| Module | Entry | Typical port |
| --- | --- | --- |
| Embedding proxy | `embedding-proxy/embedding-proxy.mjs` | `5221` |
| Dev deterministic embedding upstream | `dev-embedding-upstream/dev-embedding-upstream.mjs` | `5222` |
| Qdrant collection proxy | `qdrant-proxy/qdrant-collection-proxy.mjs` | `6334` |
| Reranker adapter | `reranker-adapter/reranker-adapter.mjs` | `8085` |
| Mem0-style extractor | `mem0-extractor/extractor.py` | `5220` |
| Fastpath recall | `fastpath/fastpath.mjs` | `5200` |
| Lexical recall | `lexical-sidecar/lexical-sidecar.mjs` | `5210` |

Run the dev deterministic embedding upstream with
`TMPDIR=/tmp npm run memory:dev-embedding-upstream` when you need a local
OpenAI-compatible endpoint for smoke tests before configuring a real provider.

## Fastpath And Lexical Implementations

The running private reference deployment uses optimized Go/Rust binaries for
fastpath and lexical recall. This public repository ships Node.js source
implementations for the same sidecar contracts so enhanced/full profiles remain
open-source runnable. Operators can replace them with optimized implementations
as long as the HTTP contracts stay compatible.

Do not commit logs, `.env` files, caches, pycache directories, model artifacts,
or copied runtime binaries into this directory.
