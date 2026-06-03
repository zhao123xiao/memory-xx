# db

Home for write-path database adapters, repositories, schema rows, and
transaction helpers.

Current C1 state:

- `adapters/in-memory-write-database.ts` keeps the existing fast unit-test path.
- `adapters/postgres-write-database.ts` provides the real PostgreSQL transaction
  runner.
- `adapters/postgres-config.ts` loads the minimal `MEMORY_V2_DATABASE_*`
  configuration surface.
- repositories now speak through the shared transaction context and can run
  against either adapter without changing the write service flow.
