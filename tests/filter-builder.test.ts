import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildRecallFilterPlan } from "../app/recall/filter-builder";
import { FilterMode } from "../app/shared";
import { RecallError } from "../app/recall/errors";

describe("buildRecallFilterPlan", () => {
  // 1. default mode without specifying requested_mode
  it("defaults to Default filter mode when requested_mode is omitted", () => {
    const plan = buildRecallFilterPlan({});
    assert.equal(plan.requested_mode, FilterMode.Default);
    assert.equal(plan.applied_mode, FilterMode.Default);
    assert.equal(plan.predicate_id, "effective_recallable");
    assert.ok(plan.sql_where_clause.length > 0);
    assert.equal(typeof plan.evaluate, "function");
  });

  // 2. default mode with Default explicitly
  it("uses Default mode when requested_mode is explicitly Default", () => {
    const plan = buildRecallFilterPlan({ requested_mode: FilterMode.Default });
    assert.equal(plan.requested_mode, FilterMode.Default);
    assert.equal(plan.applied_mode, FilterMode.Default);
    assert.equal(plan.predicate_id, "effective_recallable");
  });

  // 3. default mode evaluate approves approved+current+reviewed record
  it("evaluate returns true for approved, current, reviewed record", () => {
    const plan = buildRecallFilterPlan({});
    const record = {
      lifecycleStatus: "approved",
      isCurrent: true,
      reviewState: "approved"
    } as any;
    assert.equal(plan.evaluate(record), true);
  });

  // 4. default mode evaluate rejects tombstoned record
  it("evaluate returns false for tombstoned record", () => {
    const plan = buildRecallFilterPlan({});
    const record = {
      lifecycleStatus: "tombstone",
      isCurrent: true,
      reviewState: "approved"
    } as any;
    assert.equal(plan.evaluate(record), false);
  });

  // 5. default mode evaluate rejects non-current record
  it("evaluate returns false for non-current record", () => {
    const plan = buildRecallFilterPlan({});
    const record = {
      lifecycleStatus: "approved",
      isCurrent: false,
      reviewState: "approved"
    } as any;
    assert.equal(plan.evaluate(record), false);
  });

  // 6. governance mode requires allow_privileged_filter_modes
  it("governance mode requires allow_privileged_filter_modes", () => {
    assert.throws(
      () => buildRecallFilterPlan({ requested_mode: FilterMode.Governance }),
      (err: unknown) => {
        assert.ok(err instanceof RecallError);
        assert.equal(err.code, "invalid_filter_mode");
        return true;
      }
    );
  });

  // 7. governance mode evaluate always returns true
  it("governance mode evaluate always returns true", () => {
    const plan = buildRecallFilterPlan({
      requested_mode: FilterMode.Governance,
      allow_privileged_filter_modes: true
    });
    assert.equal(plan.applied_mode, FilterMode.Governance);
    assert.equal(plan.predicate_id, "governance_visible");
    assert.equal(plan.sql_where_clause, "TRUE");
    const record = {
      lifecycleStatus: "tombstone",
      isCurrent: false,
      reviewState: "rejected"
    } as any;
    assert.equal(plan.evaluate(record), true);
  });

  // 8. All mode evaluate always returns true
  it("All mode evaluate always returns true", () => {
    const plan = buildRecallFilterPlan({
      requested_mode: FilterMode.All,
      allow_privileged_filter_modes: true
    });
    assert.equal(plan.applied_mode, FilterMode.All);
    assert.equal(plan.predicate_id, "all_records");
    assert.equal(plan.sql_where_clause, "TRUE");
    const record = {
      lifecycleStatus: "rejected",
      isCurrent: false,
      reviewState: "pending"
    } as any;
    assert.equal(plan.evaluate(record), true);
  });

  // 9. ShadowCompare mode evaluate always returns true
  it("ShadowCompare mode evaluate always returns true", () => {
    const plan = buildRecallFilterPlan({
      requested_mode: FilterMode.ShadowCompare,
      allow_privileged_filter_modes: true
    });
    assert.equal(plan.applied_mode, FilterMode.ShadowCompare);
    assert.equal(plan.predicate_id, "shadow_compare");
    assert.equal(plan.sql_where_clause, "TRUE");
    const record = {
      lifecycleStatus: "candidate",
      isCurrent: false,
      reviewState: "pending"
    } as any;
    assert.equal(plan.evaluate(record), true);
  });

  // 10. non-default mode without privilege throws RecallError
  it("throws RecallError when requesting All without privilege", () => {
    assert.throws(
      () => buildRecallFilterPlan({ requested_mode: FilterMode.All }),
      (err: unknown) => {
        assert.ok(err instanceof RecallError);
        assert.equal(err.code, "invalid_filter_mode");
        assert.ok(err.message.includes("non-default"));
        return true;
      }
    );
  });
});
