import assert from "node:assert/strict";
import test from "node:test";

import { buildMemoryStatusTruth } from "../app/governance/memory-status-truth";

test("status truth separates runtime health from governance backlog and timer probe availability", () => {
  const status = buildMemoryStatusTruth({
    healthOk: true,
    doctorOk: true,
    doctorBlockers: [],
    qdrantProjectionOk: true,
    qdrantProjectionBodyOk: true,
    projectorOk: true,
    p1GateOk: true,
    candidateCurrent: 48,
    timerProbeOk: false,
  });

  assert.equal(status.runtime_ok, true);
  assert.equal(status.governance_ok, false);
  assert.equal(status.systemd_timer_probe_ok, false);
  assert.equal(status.ok, false);
  assert.equal(status.runtime_exit_ok, true);
  assert.deepEqual(status.status_reason, ["governance_backlog", "timer_probe_unavailable"]);
});

test("status truth can evaluate runtime-only exit semantics", () => {
  const status = buildMemoryStatusTruth({
    healthOk: true,
    doctorOk: true,
    doctorBlockers: [],
    qdrantProjectionOk: true,
    qdrantProjectionBodyOk: true,
    projectorOk: true,
    p1GateOk: true,
    candidateCurrent: 12,
    timerProbeOk: false,
    runtimeOnly: true,
  });

  assert.equal(status.ok, false);
  assert.equal(status.runtime_ok, true);
  assert.equal(status.runtime_exit_ok, true);
  assert.equal(status.exit_ok, true);
});
