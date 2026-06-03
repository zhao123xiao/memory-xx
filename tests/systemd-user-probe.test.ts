import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSystemdUserEnv,
  evaluateStatusFileFallback,
  parseSystemdShowOutput
} from "../app/ops/systemd-user";

test("buildSystemdUserEnv fills user bus environment when missing", () => {
  const env = buildSystemdUserEnv({}, 1000);

  assert.equal(env.XDG_RUNTIME_DIR, "/run/user/1000");
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
});

test("buildSystemdUserEnv preserves explicit user bus environment", () => {
  const env = buildSystemdUserEnv({
    XDG_RUNTIME_DIR: "/custom/runtime",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/bus"
  }, 1000);

  assert.equal(env.XDG_RUNTIME_DIR, "/custom/runtime");
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/custom/bus");
});

test("parseSystemdShowOutput returns unit properties", () => {
  const parsed = parseSystemdShowOutput("LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\n");

  assert.equal(parsed.LoadState, "loaded");
  assert.equal(parsed.ActiveState, "active");
  assert.equal(parsed.SubState, "running");
  assert.equal(parsed.MainPID, "123");
});

test("evaluateStatusFileFallback accepts a live running worker when systemd probe is degraded", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-status-fallback-"));
  const statusFile = path.join(dir, "qdrant-projector-worker.status.json");
  await writeFile(statusFile, JSON.stringify({
    ts: new Date().toISOString(),
    pid: 123,
    phase: "running",
    snapshot: {
      running: true,
      lastError: null,
      lastResultStatus: "idle"
    }
  }), "utf8");

  const fallback = await evaluateStatusFileFallback(statusFile, {
    staleAfterMs: 60_000,
    isProcessAlive: (pid) => pid === 123
  });

  assert.equal(fallback.ok, true);
  assert.equal(fallback.probe_degraded, true);
  assert.equal(fallback.reason, "status_file_pid_fallback");
});
