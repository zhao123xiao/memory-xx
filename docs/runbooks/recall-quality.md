# memory-xx Recall Quality Runbook

## Baseline Policy

- Eval set version is stored with the baseline.
- Baseline version is stored with the metrics.
- Do not change recall logic and lower baseline thresholds in the same change unless the approval reason is documented.
- Add holdout or random spot checks when benchmark cases are edited.

## Current Baseline

- File: `scripts/test-harness/baselines/benchmark-v1-baseline.json`
- Source report: `reports/memory-xx-tests/2026-05-20T08-41-53-839Z/L4-report.json`

## Gate Semantics

- Hermetic CI failure blocks merge.
- Live gate critical failure blocks strict/prod enablement.
- Live gate warning may merge with known risk.
- External service outage is `environment-blocked`, not a code failure.

## Required Signals

- top1/top3/top5 recall
- null and false-null rate when available
- p95/p99 latency
- degraded response contract
- forbidden hit rate must stay zero

## Trace Replay Feedback

`trace-replay` is only a hard quality signal after real positive feedback exists. Test-harness traces are filtered out by default because they are useful for smoke checks but should not become production truth labels.

Generate review candidates without writing data:

```bash
TMPDIR=/tmp npm run memory:trace-feedback -- candidates --limit=50 --days=14
```

For high-confidence real traces, you can let the conservative auto path label
only the Top-1 result when the trace is not degraded, has no forbidden hit, the
memory is approved/current, and the scope matches:

```bash
TMPDIR=/tmp npm run memory:trace-feedback -- auto-top1 --limit=20 --days=14
TMPDIR=/tmp npm run memory:trace-feedback -- auto-top1 --limit=20 --days=14 --apply
```

After manually verifying that a returned memory was actually useful for the query, add one positive label:

```bash
TMPDIR=/tmp npm run memory:trace-feedback -- apply --trace-id=<trace_id> --memory-id=<memory_id> --feedback-type=used_in_context --reason="manual quality replay label" --apply
```

Then refresh the gate:

```bash
TMPDIR=/tmp npm run memory:quality -- --suite all
TMPDIR=/tmp npm run memory:doctor -- --target quality-ready --plan
```

## Governance Debt Backfill

Use report-only mode first:

```bash
TMPDIR=/tmp npm run memory:debt-plan -- --limit=100
```

The conservative apply mode only backfills clear `metadata.source`,
episode links, and entity links. It does not create low-confidence relations,
delete data, archive data, or rewrite memory content:

```bash
TMPDIR=/tmp npm run memory:debt-plan -- --apply-conservative --limit=100
```
