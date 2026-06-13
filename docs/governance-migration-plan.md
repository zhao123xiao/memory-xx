# Memory-v2 to Memory-xx Governance Module Migration Plan

> **Status: COMPLETED (2026-06-10)** — This is a historical planning document. All modules have been migrated.

## Executive Summary

This plan outlined the migration of 11+ governance/recall modules from memory-v2 to memory-xx. All placeholder scripts have been replaced with functional implementations.

## Current State

| Category | Count | Status |
|----------|-------|--------|
| Placeholder scripts | 11 | Return exit code 1 |
| Required governance modules | 13 | Missing in memory-xx |
| Required recall modules | 1 | Missing (context-bundle) |
| Required shared types | 1 | Missing (memory-relation-types) |

## Module Dependencies Analysis

### Phase 2: Beta Capabilities (Priority Order)

1. **recall-quality-feedback** - Depends on: minimal governance deps
2. **extraction-recall-eval** - Depends on: policy engine
3. **consolidation-candidates** - Depends on: memory types

### Phase 3: Experimental Reports

4. **memory-evolve-report** - Depends on: 10+ other governance modules
5. **memory-evolve-observation-reflection** - Depends on: memory-evolve-runtime-controls
6. **memory-evolve-runtime-controls** - Core dependency for evolve
7. **observation-reflection** - Depends on: governance state

### Phase 4: Graph Governance

8. **graph-relation-repair-plan** - Depends on: memory-relation-types
9. **graph-relation-repair-executor** - Depends on: repair plan

### Phase 5: Dangerous Apply

10. **adaptive-retrieval-calibration** - Depends on: feedback data
11. **adaptive-retrieval-apply** - Depends on: calibration results
12. **stale-fact-report** - Depends on: temporal governance
13. **procedural-promotion-candidates** - Depends on: policy corpus

### Recall Module (Cross-cutting)

14. **context-bundle** - Depends on: memory-relation-types, shared types

## Implementation Strategy

### Step 1: Copy Shared Types First
- Copy `app/shared/memory-relation-types.ts` to memory-xx
- This is a simple 57-line file with no external dependencies

### Step 2: Copy Core Governance Infrastructure
- Copy `memory-evolve-runtime-controls.ts` (base dependency)
- Copy `context-hygiene-report.ts` (standalone)

### Step 3: Copy Independent Governance Modules
- Copy `stale-fact-report.ts`
- Copy `procedural-promotion-candidates.ts`
- Copy `consolidation-candidates.ts`

### Step 4: Copy Graph Governance
- Copy `graph-relation-repair-plan.ts`
- Copy `graph-relation-repair-executor.ts`

### Step 5: Copy Adaptive Retrieval
- Copy `adaptive-retrieval-calibration.ts`
- Copy `adaptive-retrieval-apply.ts`

### Step 6: Copy Extraction Recall
- Copy `extraction-recall-eval.ts`

### Step 7: Copy Recall Quality
- Copy `recall-quality-feedback.ts`

### Step 8: Copy Observation Reflection
- Copy `memory-evolve-observation-reflection.ts`

### Step 9: Copy Memory Evolve (Complex)
- Copy `memory-evolve-report.ts`

### Step 10: Copy Context Bundle
- Copy `app/recall/context-bundle.ts`

### Step 11: Update Scripts
- Replace placeholder scripts with actual implementations

## Risk Assessment

| Module | Complexity | Risk | Notes |
|--------|-----------|------|-------|
| memory-relation-types | Low | None | Pure types, no deps |
| context-hygiene-report | Low | Low | Standalone |
| stale-fact-report | Low | Low | Simple report |
| consolidation-candidates | Medium | Medium | Depends on policy |
| graph-relation-repair-* | Medium | Medium | Graph operations |
| adaptive-retrieval-* | Medium | Medium | Threshold ops |
| extraction-recall-eval | Medium | High | Complex eval |
| recall-quality-feedback | Medium | Medium | Feedback loop |
| memory-evolve-report | High | High | 928 lines, many deps |
| context-bundle | High | High | 654 lines, recall integration |

## Success Criteria

1. All 11 placeholder scripts return exit code 0
2. `npm run typecheck` passes
3. `verify:open-source` passes
4. Each module has appropriate feature-maturity status

## Files to Create/Modify

### New Files (app/governance/)
- memory-evolve-runtime-controls.ts
- memory-evolve-report.ts
- memory-evolve-observation-reflection.ts
- adaptive-retrieval-calibration.ts
- adaptive-retrieval-apply.ts
- consolidation-candidates.ts
- extraction-recall-eval.ts
- graph-relation-repair-plan.ts
- graph-relation-repair-executor.ts
- observation-reflection.ts
- procedural-promotion-candidates.ts
- recall-quality-feedback.ts
- stale-fact-report.ts
- context-hygiene-report.ts

### New Files (app/recall/)
- context-bundle.ts

### New Files (app/shared/)
- memory-relation-types.ts

### Modify Files
- package.json (already done - scripts exist)
- configs/feature-maturity.json (update status from unavailable to actual)
- scripts/*.ts (update to call actual modules)