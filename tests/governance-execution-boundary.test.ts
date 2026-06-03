import assert from "node:assert/strict";
import test from "node:test";

import {
  executeGovernanceAction,
  type GovernanceExecutionAudit
} from "../app/governance/execution-boundary";

test("executeGovernanceAction records dry-run without applying", async () => {
  const audits: GovernanceExecutionAudit<{ id: string }, { changed: boolean }>[] = [];
  let applied = false;

  const result = await executeGovernanceAction({
    actionType: "auto_update_apply",
    mode: "dry_run",
    risk: "guarded",
    actorId: "tester",
    plan: { id: "plan-1" },
    apply: async () => {
      applied = true;
      return { changed: true };
    },
    audit: async (event) => { audits.push(event); },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "planned");
  assert.equal(applied, false);
  assert.equal(audits[0].status, "planned");
});

test("executeGovernanceAction blocks apply when permission denies it", async () => {
  const audits: GovernanceExecutionAudit<{ id: string }, { changed: boolean }>[] = [];

  const result = await executeGovernanceAction({
    actionType: "global_auto_approval",
    mode: "apply",
    risk: "high_risk",
    actorId: "tester",
    plan: { id: "plan-2" },
    permissions: { canApply: false, blockedReason: "global_requires_manual_approval" },
    apply: async () => ({ changed: true }),
    audit: async (event) => { audits.push(event); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.blocked_reason, "global_requires_manual_approval");
  assert.equal(audits[0].status, "blocked");
});

test("executeGovernanceAction applies under lease and releases it", async () => {
  const audits: GovernanceExecutionAudit<{ id: string }, { changed: boolean }>[] = [];
  let released = false;

  const result = await executeGovernanceAction({
    actionType: "recall_repair_apply",
    mode: "apply",
    risk: "safe",
    actorId: "tester",
    plan: { id: "plan-3" },
    permissions: { canApply: true },
    lease: {
      acquire: async () => true,
      release: async () => { released = true; },
    },
    apply: async () => ({ changed: true }),
    audit: async (event) => { audits.push(event); },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "applied");
  assert.deepEqual(result.result, { changed: true });
  assert.equal(released, true);
  assert.equal(audits[0].status, "applied");
});
