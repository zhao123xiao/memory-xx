# memory-xx Sidecars

`sidecars/` contains optional modules from the memory-xx full stack. The wrapper
must keep working when an optional sidecar is disabled or degraded.

## Included Source

| Module | Entry | Typical port |
| --- | --- | --- |
| Embedding proxy | `embedding-proxy/embedding-proxy.mjs` | `5221` |
| Qdrant collection proxy | `qdrant-proxy/qdrant-collection-proxy.mjs` | `6334` |
| Reranker adapter | `reranker-adapter/reranker-adapter.mjs` | `8085` |
| Mem0-style extractor | `mem0-extractor/extractor.py` | `5220` |

## Pending Source Import

The running private reference deployment also uses Go fastpath and Rust lexical
sidecars. Only their running binaries were found during the first public export
audit, so this repository currently ships module metadata and placeholders for
those two components until their source trees are imported.

Do not commit logs, `.env` files, caches, pycache directories, model artifacts,
or copied runtime binaries into this directory.
