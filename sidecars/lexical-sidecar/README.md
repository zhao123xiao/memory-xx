# Lexical Recall Sidecar

The private reference deployment currently runs a Rust lexical sidecar backed by
PostgreSQL lexical terms. During the first public memory-xx export audit, only
the running ELF binary was found, not the source tree.

This placeholder keeps the module visible in the public runtime registry while
making the open-source gap explicit.

Expected module behavior:

- `MEMORY_XX_LEXICAL_SIDECAR_ENABLED=0` disables the module.
- If disabled or unhealthy, recall falls back to vector, graph, and PostgreSQL
  lexical paths already available inside the wrapper.
- `full` profile treats this module as required for release parity.
- `enhanced` profile treats it as expected but degradable.

Do not commit copied runtime binaries here. The next implementation step is to
import or recreate the Rust source and build instructions.
