import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function runRuntimeModuleEnabled(moduleName: string, env: Record<string, string | undefined>) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/runtime-module-enabled.ts", moduleName],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MEMORY_XX_ENV_PATH: "/tmp/memory-xx-no-env",
        ...env,
      },
      encoding: "utf8",
    }
  );
}

test("runtime-module-enabled rejects modules with unavailable public source", () => {
  const result = runRuntimeModuleEnabled("fastpath", {
    MEMORY_XX_RUNTIME_PROFILE: "full",
    MEMORY_XX_FASTPATH_ENABLED: "1",
    MEMORY_XX_FASTPATH_SOURCE_AVAILABLE: "0",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /fastpath unavailable: missing_dependency/u);
  assert.match(result.stderr, /MEMORY_XX_FASTPATH_SOURCE_AVAILABLE=disabled/u);
});

test("runtime-module-enabled rejects enabled external modules without required health URL", () => {
  const result = runRuntimeModuleEnabled("llm_upstream", {
    MEMORY_XX_RUNTIME_PROFILE: "full",
    MEMORY_XX_LLM_UPSTREAM_ENABLED: "1",
    MEMORY_XX_LLM_UPSTREAM_HEALTH_URL: "",
    MEMORY_XX_MEM0_BASE_URL: "",
    MEMORY_INTELLIGENCE_BASE_URL: "",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /llm_upstream unavailable: missing_dependency/u);
  assert.match(result.stderr, /health_url_unconfigured/u);
});
