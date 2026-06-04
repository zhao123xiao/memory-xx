# Fastpath Recall Sidecar

`fastpath.mjs` is the public Node.js implementation of the memory-xx fastpath
contract. It serves `/health`, `/recall-fast`, and `/admin/cache/invalidate`.
The private reference deployment can use an optimized implementation, but this
source entry keeps enhanced/full profiles open-source runnable.

Expected module behavior:

- `MEMORY_XX_FASTPATH_ENABLED=0` disables the module.
- If disabled or unhealthy, wrapper recall falls back to the Node path.
- `full` profile treats this module as required for release parity.
- `enhanced` profile treats it as expected but degradable.
- If PostgreSQL or lexical sidecar is not configured, `/recall-fast` returns
  `ok: true`, `degraded: true`, and an empty candidate list instead of crashing.

Do not commit copied runtime binaries here.
