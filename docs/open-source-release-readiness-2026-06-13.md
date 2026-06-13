# memory-xx open-source release readiness

Date: 2026-06-13  
Scope: `memory-xx` as the open-source mirror of `memory-v2`

## Position

`memory-xx` is aligned with `memory-v2` as a full-feature open-source mirror, with open-source-safe names and defaults:

- Environment variables use `MEMORY_XX_*`.
- HTTP APIs use `/api/memory/xx`.
- Runtime examples use generic local ports, generic scope IDs, and placeholder paths.
- No private `.env`, real credentials, personal scope defaults, or private runtime bindings are required for the public repo.

## Mirror Parity Evidence

Command:

```bash
TMPDIR=/tmp npm run memory:parity-audit -- --json --fail-on-missing
```

Result:

- `ok=true`
- Missing normalized files: 0
- `memory-v2` source-only package scripts: 0 (`source-only scripts 0`)
- Private residue hits: 0 (`residue hits 0`)
- Extra `memory-xx` scripts are open-source release helpers: `audit:prod`, `verify:open-source`, `memory:parity-audit`

The parity audit compares `app/`, `scripts/`, `tests/`, `migrations/`, `systemd/`, and `configs/`, while normalizing private `memory-v2` naming into public `memory-xx` naming.

## Open-Source Verification

Command:

```bash
TMPDIR=/tmp npm run typecheck
TMPDIR=/tmp npm run verify:open-source
```

Result:

- TypeScript typecheck passed.
- Full test suite passed: 885 tests, 882 pass, 0 fail, 3 skipped.
- Secret scan passed.
- Open-source preaudit passed with 0 blockers and 0 warnings.
- The `verify-open-source-parity` gate runs inside `verify:open-source`; when a sibling memory-v2 checkout is present it executes `memory:parity-audit -- --fail-on-missing`, and when that private checkout is absent it prints an explicit skip message.
- Open-source readiness tests passed.
- The release readiness doc gate passed as part of `verify:open-source` (`release readiness doc gate passed`).
- Production dependency audit found 0 vulnerabilities.

## Runtime Gate Evidence

The following gates were rerun against an isolated local `memory-xx` runtime on port `5110`, with a temporary Qdrant collection and test-only Redis / embedding endpoints. The wrapper and Qdrant projector were stopped after verification.

| Gate | Result | Evidence |
| --- | --- | --- |
| `test:prod-e2e` | PASS | run_id `290795ac`, 8/8 checks, write -> approve -> project -> recall -> tombstone verified |
| `test:load` | PASS | run_id `af3f36ec`, 3/3 checks, 50 requests, 0 5xx/429/4xx, p99 193ms, cleanup 19/19 |
| `test:multi-agent-contract` | PASS | run_id `97c501e2`, 10/10 checks, shared recall and isolation verified |
| `test:knowledge-e2e` | PASS | run_id `b154a385`, 6/6 checks, knowledge search and hybrid source disambiguation verified |
| `test:data-governance` | PASS | run_id `5e6b37ff`, 3/3 checks, production test pollution 0 |

## Remaining Risks

- `memory:evolve` remains report-only / dry-run first. This matches current safety posture; a real apply mode would need explicit `--apply --plan`, governance audit records, failure diagnostics, and rollback evidence.
- Public CI and `verify:open-source` conditionally run `memory:parity-audit` only when a sibling `memory-v2` checkout is present. This avoids binding the open-source repo to a private upstream while preserving a strong internal mirror gate.
- Historical or internal planning documents in `docs/` must remain clearly marked as historical or be rewritten before a tagged public release if they could confuse users about current maturity.

## Historical Documents

These documents are retained for traceability and do not describe the current runtime gap state:

- `docs/governance-migration-plan.md` — historical migration plan, superseded by current parity evidence.
- `docs/memory-v2-alignment-implementation-checklist-2026-06-09.md` — historical implementation checklist, superseded by current parity evidence.
- `docs/superpowers/plans/2026-06-10-memory-v2-final-migration-checklist.md` — historical agent execution plan, superseded by current parity evidence.

## Release Decision

The current state is suitable for a public preview release candidate of the `memory-v2` open-source mirror, provided the release notes keep the dangerous apply boundary explicit and include the parity/open-source verification commands above.
