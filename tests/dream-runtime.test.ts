import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("runtime wires Dream Scheduler with the planned project maintenance tasks", () => {
  const runtimeSource = readFileSync(path.join(process.cwd(), "app/server/runtime.ts"), "utf8");
  const taskSource = readFileSync(path.join(process.cwd(), "app/dream/dream-tasks.ts"), "utf8");

  assert.match(runtimeSource, /DreamScheduler/u);
  assert.match(runtimeSource, /DreamWorker/u);
  assert.match(runtimeSource, /loadDreamSchedulerConfig/u);
  assert.match(runtimeSource, /export let dreamScheduler/u);
  assert.match(runtimeSource, /dreamScheduler\s*=\s*createRuntimeDreamScheduler\([^)]*\)/u);
  assert.match(runtimeSource, /dreamScheduler\?\.start\(\)/u);
  assert.match(runtimeSource, /dreamScheduler\.stop\(\)/u);

  assert.match(taskSource, /selectDecayArchiveCandidates/u);
  assert.match(taskSource, /runConsolidation/u);
  assert.match(taskSource, /evaluateAutoApprovalPolicy/u);
  assert.match(taskSource, /id:\s*"decay_archive"/u);
  assert.match(taskSource, /id:\s*"consolidation_run"/u);
  assert.match(taskSource, /id:\s*"candidate_auto_approve"/u);
});
