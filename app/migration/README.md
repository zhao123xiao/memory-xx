# migration

Home for schema migration, backfill, shadow-compare, and rebuild workflows.

Current C6 state:

- `runner.ts` still owns ordered SQL schema migrations.
- `audit-ledger.ts` provides the minimum migration audit bottom ledger used by
  shadow compare runs.
- `recall-shadow.ts` runs recall shadow compare against frozen baselines and
  records scope/default-filter/zero-hit/degrade/result-set diffs.
- `projection-shadow.ts` runs Markdown projection shadow compare for the
  optional read-only export path.
- `runtime-chain.ts` runs recall compare as the executable migration/shadow
  runtime chain with a minimal scorecard.

Hard boundary:

- shadow compare is evidence only; it does **not** promote memory-xx into a
  dual-primary production chain.
- Markdown projection remains a review/export view; Postgres records/events are
  the source of truth and reverse sync is not allowed.
- default filtering is never relaxed just to match old results.
- scope violations are reported separately from ordinary result mismatch.
