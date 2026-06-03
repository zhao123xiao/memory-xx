# shared

Phase A stores only frozen contracts, enums, constant paths, and canonical
predicate helpers here.

The `contracts/visibility.ts` helper is the A-side first-cut explanation layer
for memory-level `visibility: Visibility` semantics. It explicitly models
visibility as a contract/business semantic derived from existing
`scope_type/scope_id + route/filter governance semantics`, while keeping the
boundary clear that this is **not** yet a physical main-table column.

The same module now also exposes the canonical visibility-order, route/runtime
scope-name parsing helper, and the minimal allowance-summary fallback helpers
used by A-side `allowedVisibilities` plan summaries, so memory-level
explanation and allowance-layer vocabulary do not drift into separate
hand-written mapping sources.

No business orchestration belongs in this module yet.
