# migration

Home for schema migration, backfill, shadow-compare, and rebuild workflows.

Current C6 state:

- `runner.ts` still owns ordered SQL schema migrations.
- `audit-ledger.ts` provides the minimum migration audit bottom ledger used by
  shadow compare runs.
- `recall-shadow.ts` runs recall shadow compare against frozen baselines and
  records scope/default-filter/zero-hit/degrade/result-set diffs.
- `runtime-chain.ts` runs recall compare as the executable migration/shadow
  runtime chain with a minimal scorecard.
- Markdown projection shadow has been retired; current audit evidence should use
  Postgres records/events, graph reports, recall traces, Qdrant reconcile, and
  L3/L4 quality reports.

Hard boundary:

- shadow compare is evidence only; it does **not** promote memory-xx into a
  dual-primary production chain.
- default filtering is never relaxed just to match old results.
- scope violations are reported separately from ordinary result mismatch.
