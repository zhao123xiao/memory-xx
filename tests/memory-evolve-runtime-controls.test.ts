import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  defaultMemoryEvolveRuntimeControls,
  enabledMemoryEvolveModules,
  readMemoryEvolveRuntimeControlsStateSync,
} from "../app/governance/memory-evolve-runtime-controls";

function withRuntimeDir<T>(callback: (dir: string) => T): T {
  const previousRuntimeDir = process.env.MEMORY_XX_RUNTIME_DIR;
  const dir = mkdtempSync(join(tmpdir(), "memory-xx-evolve-runtime-controls-"));
  process.env.MEMORY_XX_RUNTIME_DIR = dir;
  try {
    return callback(dir);
  } finally {
    if (previousRuntimeDir === undefined) delete process.env.MEMORY_XX_RUNTIME_DIR;
    else process.env.MEMORY_XX_RUNTIME_DIR = previousRuntimeDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("memory evolve runtime controls default to closed when no runtime file exists", () => withRuntimeDir(() => {
  const state = readMemoryEvolveRuntimeControlsStateSync();

  assert.equal(state.ok, true);
  assert.equal(state.exists, false);
  assert.deepEqual(enabledMemoryEvolveModules(state.controls), {
    context_hygiene: false,
    consolidation: false,
    extraction_recall_eval: false,
    policy_feedback_backprop: false,
    procedural_promotion: false,
  });
}));

test("memory evolve runtime controls normalize enabled module flags", () => withRuntimeDir((dir) => {
  writeFileSync(join(dir, "memory-evolve-runtime-controls.json"), JSON.stringify({
    version: 1,
    modules: {
      context_hygiene: { enabled: true },
      consolidation: { enabled: true },
      extraction_recall_eval: { enabled: true },
      policy_feedback_backprop: { enabled: true },
      procedural_promotion: { enabled: true },
      unknown_future_module: { enabled: true },
    },
  }, null, 2), "utf8");

  const state = readMemoryEvolveRuntimeControlsStateSync();

  assert.equal(state.ok, true);
  assert.equal(state.exists, true);
  assert.deepEqual(enabledMemoryEvolveModules(state.controls), {
    context_hygiene: true,
    consolidation: true,
    extraction_recall_eval: true,
    policy_feedback_backprop: true,
    procedural_promotion: true,
  });
}));

test("malformed memory evolve runtime controls fail closed", () => withRuntimeDir((dir) => {
  writeFileSync(join(dir, "memory-evolve-runtime-controls.json"), "{ not json", "utf8");

  const state = readMemoryEvolveRuntimeControlsStateSync();

  assert.equal(state.ok, false);
  assert.equal(state.exists, true);
  assert.deepEqual(state.controls, defaultMemoryEvolveRuntimeControls());
}));
