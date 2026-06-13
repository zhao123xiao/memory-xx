# memory-v2 Final Migration Implementation Plan

> **Status: HISTORICAL / SUPERSEDED (2026-06-13)** — This plan records pre-migration execution work. It is kept for traceability and does not describe the current `memory-xx` runtime gap state. Use `docs/memory-v2-full-feature-parity-audit-2026-06-11.md` and `docs/open-source-release-readiness-2026-06-13.md` for the current release baseline.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the final `memory-v2` to `memory-xx` migration so `memory-xx` has aligned CLI entries, complete core governance modules, matching tests, truthful maturity metadata, and passing open-source verification.

**Architecture:** Keep `memory-xx` open-source safe while preserving the real `memory-v2` governance behavior. Report-only modules should remain read-only by default; write-capable governance commands must keep a dry-run-first contract and require explicit `--apply`.

**Tech Stack:** TypeScript, Node.js test runner, `tsx` import hook via `node --import tsx`, npm scripts, JSON maturity config, memory-xx governance and recall modules.

---

## Current Baseline

- `package.json` scripts are aligned with `memory-v2`; no missing public entrypoints were found.
- `configs/feature-maturity.json` is valid JSON and currently has no `status: "unavailable"` entries.
- `npm run typecheck` passes.
- `TMPDIR=/tmp node --import tsx --test tests/feature-maturity.test.ts` passes 8/8.
- `npm run verify:open-source` passes, including open-source readiness tests and `npm audit --omit=dev`.
- Remaining migration gaps are concentrated in `memory:evolve` dependencies and one missing test.

## Implementation Checklist

### Task 1: Migrate Remaining `memory:evolve` Modules

**Files:**
- Create: `app/governance/memory-evolve-report.ts`
- Create: `app/governance/memory-evolve-observation-reflection.ts`
- Create: `app/governance/memory-evolve-runtime-controls.ts`
- Create: `app/governance/observer-reflector-governor.ts`
- Modify if needed: `app/governance/index.ts`

- [ ] Copy the corresponding modules from `<memory-v2-checkout>/app/governance/`.
- [ ] Replace private names, local paths, and environment assumptions with `memory-xx` equivalents.
- [ ] Keep report-only behavior read-only by default.
- [ ] Ensure runtime controls default to conservative report-only behavior.
- [ ] Export the new modules through the existing governance barrel only if local patterns already do so.
- [ ] Run:

```bash
npm run typecheck
```

Expected: exit code 0.

### Task 2: Finish `memory:evolve` CLI Integration

**Files:**
- Modify: `scripts/memory-evolve.ts`
- Modify if needed: `package.json`

- [ ] Wire `scripts/memory-evolve.ts` to the migrated report builder instead of simplified or partial local behavior.
- [ ] Ensure `npm run memory:evolve -- --help` exits 0 and prints usage.
- [ ] Ensure `npm run memory:evolve -- --json` exits 0 and emits valid JSON.
- [ ] Ensure empty data produces an empty report or clear report-only result, not a placeholder or not-implemented response.
- [ ] Ensure the report includes these sections when data is available: stale facts, consolidation, adaptive calibration, extraction-recall, recall feedback, observation reflection, procedural promotion, graph relation repair.
- [ ] Run:

```bash
npm run memory:evolve -- --help
npm run memory:evolve -- --json
```

Expected: both exit code 0; the second command outputs parseable JSON.

### Task 3: Add Missing Adaptive Retrieval Apply Test

**Files:**
- Create: `tests/adaptive-retrieval-apply.test.ts`
- Modify if needed: `app/governance/adaptive-retrieval-apply.ts`

- [ ] Add tests for blocked plans when no threshold change is proposed.
- [ ] Add tests for tighten and loosen threshold plans.
- [ ] Add tests that actor id and run id are preserved in the result or audit metadata where supported by the implementation.
- [ ] Add tests proving write-capable behavior is not executed without explicit apply-mode input.
- [ ] Run:

```bash
TMPDIR=/tmp node --import tsx --test tests/adaptive-retrieval-apply.test.ts
```

Expected: exit code 0.

### Task 4: Validate Migrated Governance Tests

**Files:**
- Existing or create as needed: `tests/memory-evolve-report.test.ts`
- Existing or create as needed: `tests/observer-reflector-governor.test.ts`
- Existing: `tests/recall-context-bundle.test.ts`
- Existing: `tests/graph-relation-repair-executor.test.ts`
- Existing: `tests/human-review-apply.test.ts`
- Existing: `tests/extraction-recall-eval.test.ts`
- Existing: `tests/recall-quality-feedback.test.ts`
- Existing: `tests/procedural-promotion-candidates.test.ts`

- [ ] Confirm each test imports from `memory-xx` paths, not private `memory-v2` paths.
- [ ] Remove any hardcoded private checkout path from test fixtures.
- [ ] Keep tests deterministic: no real database, no network, no production credentials.
- [ ] Run:

```bash
TMPDIR=/tmp node --import tsx --test tests/memory-evolve-report.test.ts
TMPDIR=/tmp node --import tsx --test tests/observer-reflector-governor.test.ts
TMPDIR=/tmp node --import tsx --test tests/recall-context-bundle.test.ts
TMPDIR=/tmp node --import tsx --test tests/graph-relation-repair-executor.test.ts
TMPDIR=/tmp node --import tsx --test tests/human-review-apply.test.ts
TMPDIR=/tmp node --import tsx --test tests/extraction-recall-eval.test.ts
TMPDIR=/tmp node --import tsx --test tests/recall-quality-feedback.test.ts
TMPDIR=/tmp node --import tsx --test tests/procedural-promotion-candidates.test.ts
```

Expected: all commands exit code 0.

### Task 5: Reconcile Feature Maturity Metadata and Docs

**Files:**
- Modify: `configs/feature-maturity.json`
- Modify: `docs/feature-maturity.zh-CN.md`
- Modify if needed: `tests/feature-maturity.test.ts`

- [ ] Keep `configs/feature-maturity.json` parseable by `JSON.parse`.
- [ ] Ensure implemented features do not use `status: "unavailable"`.
- [ ] Keep `dangerous` features marked with `requires_apply: true` and `public_warning`.
- [ ] Ensure docs match actual CLI behavior and no longer describe completed features as unavailable.
- [ ] Run:

```bash
node -e "JSON.parse(require('fs').readFileSync('configs/feature-maturity.json','utf8'))"
TMPDIR=/tmp node --import tsx --test tests/feature-maturity.test.ts
```

Expected: both commands exit code 0.

### Task 6: Remove Migration Residue

**Files:**
- Inspect: `scripts/`
- Inspect: `app/`
- Inspect: `configs/`
- Inspect: `docs/`

- [ ] Search for current implementation residue:

```bash
rg "placeholder script|not yet implemented|requires migration|Status: .*not available|status\\\": \\\"unavailable\\\"" scripts app configs docs
```

Expected: no matches for current implementation. Historical migration notes are acceptable only if clearly marked as historical and not user-facing runtime status.

- [ ] Search for private paths and secrets:

```bash
rg -n "(sk-[A-Za-z0-9]|Bearer [A-Za-z0-9._-]{20,}|API_TOKEN=|PASSWORD=|SECRET=|PRIVATE KEY|BEGIN .*KEY|<private-home>|<private-windows-home>)" app scripts configs docs tests
```

Expected: no secrets; no private local paths in public docs, configs, runtime code, or tests.

### Task 7: Final Verification

- [ ] Run the full final gate:

```bash
npm run typecheck
TMPDIR=/tmp node --import tsx --test tests/feature-maturity.test.ts
TMPDIR=/tmp node --import tsx --test tests/adaptive-retrieval-apply.test.ts
TMPDIR=/tmp node --import tsx --test tests/memory-evolve-report.test.ts
TMPDIR=/tmp node --import tsx --test tests/observer-reflector-governor.test.ts
TMPDIR=/tmp node --import tsx --test tests/recall-context-bundle.test.ts
TMPDIR=/tmp node --import tsx --test tests/graph-relation-repair-executor.test.ts
TMPDIR=/tmp node --import tsx --test tests/human-review-apply.test.ts
TMPDIR=/tmp node --import tsx --test tests/extraction-recall-eval.test.ts
TMPDIR=/tmp node --import tsx --test tests/recall-quality-feedback.test.ts
TMPDIR=/tmp node --import tsx --test tests/procedural-promotion-candidates.test.ts
npm run verify:open-source
```

Expected: every command exits 0.

- [ ] Confirm public entrypoint alignment:

```bash
node - <<'NODE'
const fs=require('fs');
const path=require('path');
function scripts(dir){
  const p=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));
  return Object.keys(p.scripts||{}).filter(k=>k.startsWith('memory:')||k.startsWith('test:auto')||k.includes('qdrant')||k.includes('governance')||k.startsWith('verify:')||k.startsWith('open-source:')||k.startsWith('mcp:')).sort();
}
const v2=scripts('<memory-v2-checkout>');
const xx=scripts('<memory-xx-checkout>');
console.log(JSON.stringify({v2:v2.length,memoryxx:xx.length,missing:v2.filter(k=>!xx.includes(k)),extra:xx.filter(k=>!v2.includes(k))},null,2));
NODE
```

Expected: `missing` is `[]`. Extra entries are allowed only for open-source verification helpers such as `verify:open-source`.

## Completion Criteria

- Key migration file checklist reaches 27/27 present.
- `memory:evolve -- --json` produces a complete, parseable aggregation report.
- All migrated tests pass.
- Feature maturity metadata is valid and truthful.
- Open-source verification passes with 0 production dependency vulnerabilities.
- No current runtime or docs residue claims a completed feature is a placeholder, not implemented, or unavailable.

## Assumptions

- The completion target is real feature migration, not only open-source-safe placeholder publication.
- Dry-run-first remains mandatory for write-capable governance features.
- `experimental` and `dangerous` maturity labels can remain after migration, but `unavailable` must not remain for implemented features.
- No GitHub push or commit is required by this plan unless requested separately.
