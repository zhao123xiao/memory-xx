import assert from "node:assert/strict";
import test from "node:test";

import { classifyMcpToolsContractSeverity } from "../scripts/test-harness/layers/L1-unit-contract";

test("L1 MCP contract treats unauthorized live wrapper responses as environment warnings", () => {
  assert.equal(classifyMcpToolsContractSeverity(401, { error: "unauthorized" }), "warning");
  assert.equal(classifyMcpToolsContractSeverity(200, { error: "unauthorized" }), "warning");
  assert.equal(classifyMcpToolsContractSeverity(404, { error: "not_found" }), "critical");
});
