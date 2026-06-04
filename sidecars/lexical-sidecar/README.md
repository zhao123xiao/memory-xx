# Lexical Recall Sidecar

`lexical-sidecar.mjs` is the public Node.js implementation of the memory-xx
lexical recall sidecar contract. It serves `/health`, `/search`, and `/recall`.
The private reference deployment can use an optimized implementation, but this
source entry keeps enhanced/full profiles open-source runnable.

Expected module behavior:

- `MEMORY_XX_LEXICAL_SIDECAR_ENABLED=0` disables the module.
- If disabled or unhealthy, recall falls back to vector, graph, and PostgreSQL
  lexical paths already available inside the wrapper.
- `full` profile treats this module as required for release parity.
- `enhanced` profile treats it as expected but degradable.
- If PostgreSQL is not configured, `/search` returns `ok: true`,
  `degraded: true`, and an empty candidate list instead of crashing.

Do not commit copied runtime binaries here.
