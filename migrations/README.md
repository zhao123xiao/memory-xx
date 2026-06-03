# memory-xx migrations

Migrations are append-only once applied to a live ledger. Do not rename an
applied file to make the filename prettier; add a new migration instead.

Known compatibility exception:

- `0017_governance_run_lease.sql`
- `0017_scope_generations.sql`

Both share prefix `0017` because they were split after the first `0017` had
already been applied in live environments. The migration runner records them as
`0017_governance_run_lease` and `0017_scope_generations`, and
`check:migrations` treats this exact pair as the only allowed duplicate prefix.
Future duplicate numeric prefixes must fail review.

## Rollback policy

This project uses forward-only migrations. Do not add synthetic `.down.sql`
files for migrations that have already reached a live ledger. Production
rollback is handled by a new corrective migration plus the relevant operational
rollback path: embedding manifest rollback, Qdrant alias rollback, outbox replay,
or report-only repair scripts. This keeps the live ledger auditable and avoids
pretending that schema/data changes are safely reversible when they are not.
