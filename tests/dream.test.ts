import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DreamWorker, type DreamTask, type DreamTaskResult } from "../app/dream/dream-worker";
import { DreamScheduler } from "../app/dream/dream-scheduler";

function createMockTask(id: string, result: Partial<DreamTaskResult> = {}): DreamTask {
  return {
    id,
    name: `Task ${id}`,
    description: `Mock task ${id}`,
    async execute(): Promise<DreamTaskResult> {
      return {
        task_id: id,
        task_name: this.name,
        status: "completed",
        duration_ms: 10,
        summary: `Mock task ${id} done`,
        ...result,
      };
    },
  };
}

describe("DreamWorker", () => {
  it("runs registered tasks", async () => {
    const worker = new DreamWorker();
    worker.registerTask(createMockTask("t1"));
    worker.registerTask(createMockTask("t2"));

    const report = await worker.run();
    assert.equal(report.tasks.length, 2);
    assert.equal(report.summary.completed, 2);
    assert.equal(report.summary.failed, 0);
    assert.ok(report.started_at);
    assert.ok(report.completed_at);
    assert.ok(report.total_duration_ms >= 0);
  });

  it("handles task failures gracefully", async () => {
    const worker = new DreamWorker();
    worker.registerTask(createMockTask("good"));
    worker.registerTask({
      id: "bad",
      name: "Bad Task",
      description: "Always fails",
      async execute() { throw new Error("boom"); },
    });

    const report = await worker.run();
    assert.equal(report.summary.completed, 1);
    assert.equal(report.summary.failed, 1);
    assert.equal(report.tasks[1].status, "failed");
    assert.ok(report.tasks[1].summary.includes("boom"));
  });

  it("handles skipped tasks", async () => {
    const worker = new DreamWorker();
    worker.registerTask(createMockTask("skip", { status: "skipped" }));

    const report = await worker.run();
    assert.equal(report.summary.skipped, 1);
    assert.equal(report.summary.completed, 0);
  });

  it("returns empty report with no tasks", async () => {
    const worker = new DreamWorker();
    const report = await worker.run();
    assert.equal(report.tasks.length, 0);
    assert.equal(report.summary.completed, 0);
  });

  it("lists registered tasks", () => {
    const worker = new DreamWorker();
    worker.registerTask(createMockTask("a"));
    worker.registerTask(createMockTask("b"));
    const list = worker.listTasks();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, "a");
    assert.equal(list[1].name, "Task b");
  });
});

describe("DreamScheduler", () => {
  it("does not start when disabled", () => {
    const worker = new DreamWorker();
    const scheduler = new DreamScheduler(worker, { intervalMs: 1000, enabled: false });
    scheduler.start();
    assert.equal(scheduler.isRunning, false);
    assert.equal(scheduler.lastDreamReport, null);
  });

  it("starts when enabled", () => {
    const worker = new DreamWorker();
    worker.registerTask(createMockTask("test"));
    const scheduler = new DreamScheduler(worker, { intervalMs: 60000, enabled: true });
    scheduler.start();
    // The first cycle runs immediately but is async — just check it started
    scheduler.stop();
  });

  it("runOnce executes a cycle", async () => {
    const worker = new DreamWorker();
    worker.registerTask(createMockTask("once"));
    const scheduler = new DreamScheduler(worker, { intervalMs: 60000, enabled: false });

    const report = await scheduler.runOnce();
    assert.ok(report);
    assert.equal(report.tasks.length, 1);
    assert.equal(scheduler.lastDreamReport, report);
  });

  it("runOnce returns a stable skipped report for first overlapping cycle", async () => {
    const worker = new DreamWorker();
    let release!: () => void;
    worker.registerTask({
      id: "slow",
      name: "Slow",
      description: "waits",
      async execute() {
        await new Promise<void>((resolve) => { release = resolve; });
        return { task_id: "slow", task_name: "Slow", status: "completed", duration_ms: 1, summary: "done" };
      }
    });
    const scheduler = new DreamScheduler(worker, { intervalMs: 60000, enabled: false });
    const first = scheduler.runOnce();
    const second = await scheduler.runOnce();
    assert.equal(second.summary.skipped, 1);
    assert.equal(second.tasks[0]?.status, "skipped");
    release();
    assert.equal((await first).summary.completed, 1);
  });

  it("stop clears timer", () => {
    const worker = new DreamWorker();
    const scheduler = new DreamScheduler(worker, { intervalMs: 60000, enabled: true });
    scheduler.start();
    scheduler.stop();
    // No assertion needed — just verifying no crash
  });
});
