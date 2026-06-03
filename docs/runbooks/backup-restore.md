# memory-xx Backup And Restore Runbook

## Targets

- RPO: 1 hour by default.
- RTO: 2 hours by default for the local WSL service.
- Source of truth: PostgreSQL.
- Rebuildable projections: Qdrant and Redis.

## Backup

1. Stop destructive live gates or ensure they use a test namespace.
2. Run `TMPDIR=/tmp npm run memory:backup` to inspect the backup plan.
3. Run `TMPDIR=/tmp npm run memory:backup -- --apply` to capture the
   PostgreSQL schema dump, Qdrant active alias metadata, `.env`, and systemd
   user units.
4. Store database dumps under a non-repo backup directory with mode `0600` or stricter.
5. Encrypt off-host copies before transfer.
6. Include tombstoned records in backup. Tombstone is logical invisibility, not physical deletion.

## Restore Drill

1. Restore schema into a shadow PostgreSQL database.
2. Restore data subset or full data according to the drill target.
3. Run migrations forward to the current version.
4. Rebuild Qdrant from PostgreSQL outbox/replay or projection repair.
5. Run 20 sampled recall smoke checks against the restored stack.

## Access Control

- Restore requires admin credentials.
- Backup artifacts must not be committed.
- If future physical purge is implemented, backup purge propagation must be defined before enabling purge.
