# memory-xx Migration Rollback Runbook

## Rules

- Applied migrations are never renamed in place.
- Historical duplicate-prefix exceptions are registered for:
  - `0017_governance_run_lease.sql`
  - `0017_scope_generations.sql`
- New migrations must use unique numeric prefixes.
- If a migration has already reached a live DB, repair with a forward migration.

## Drill

1. Create an empty shadow DB.
2. Run `MEMORY_XX_ENV_PATH=<project-root>/.env npm run migrate`.
3. Verify `memory_xx_schema_migrations` has unique versions and expected filenames.
4. For reversible migrations, execute the documented down SQL in the shadow DB.
5. For irreversible migrations, verify the forward repair script and documented irreversible point.

## Failure Handling

- If a migration fails before the ledger insert, fix and rerun.
- If a migration partially changed data outside transaction boundaries, do not edit the historical migration; write a forward repair migration.
- If a duplicate prefix is introduced after 0020, the migration gate must fail.
