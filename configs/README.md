# configs

Non-secret `MEMORY_V2_*` configuration templates live here.

- `memory-xx.env.example` is the minimum Postgres write-path template for
  `npm run migrate` and `npm run test:postgres`.
- `memory-xx-wrapper.env.example` is the systemd/user wrapper env template.
- `memory-xx-qdrant-projector-worker.env.example` is the dedicated systemd/user
  env template for the long-running Qdrant projector worker.
