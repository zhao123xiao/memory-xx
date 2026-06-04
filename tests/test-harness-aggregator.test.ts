import assert from "node:assert/strict";
import test from "node:test";

import { buildHarnessLayerScripts } from "../scripts/test-harness/reports/aggregator";

test("OpenClaw harness layer is optional unless explicitly required", () => {
  const defaults = buildHarnessLayerScripts();
  const explicit = buildHarnessLayerScripts({ requireOpenClaw: true });

  const defaultL7 = defaults.find((layer) => layer.id === "L7");
  const explicitL7 = explicit.find((layer) => layer.id === "L7");

  assert.equal(defaultL7?.name, "OpenClaw Integration");
  assert.equal(defaultL7?.required, false);
  assert.equal(explicitL7?.required, true);
});

test("OpenClaw harness layer can be required by environment switch", () => {
  const previous = process.env.MEMORY_XX_REQUIRE_OPENCLAW_INTEGRATION;
  process.env.MEMORY_XX_REQUIRE_OPENCLAW_INTEGRATION = "1";
  try {
    const layer = buildHarnessLayerScripts().find((item) => item.id === "L7");
    assert.equal(layer?.required, true);
  } finally {
    if (previous === undefined) {
      delete process.env.MEMORY_XX_REQUIRE_OPENCLAW_INTEGRATION;
    } else {
      process.env.MEMORY_XX_REQUIRE_OPENCLAW_INTEGRATION = previous;
    }
  }
});
