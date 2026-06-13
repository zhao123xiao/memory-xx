import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildTrustedAgentSmokeReport } from "../scripts/trusted-agent-smoke";

test("trusted agent smoke reports missing live configuration", async () => {
  const report = await buildTrustedAgentSmokeReport({
    env: {
      MEMORY_XX_DATABASE_URL: "",
      MEMORY_XX_CLI_TOKEN: "",
      MEMORY_XX_ADMIN_TOKEN: "",
      MEMORY_XX_API_TOKEN: "",
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers, [
    "missing_env:MEMORY_XX_DATABASE_URL",
    "missing_env:MEMORY_XX_CLI_TOKEN_OR_MEMORY_XX_ADMIN_TOKEN",
  ]);
});

test("trusted agent smoke validates agent audit and trusted agent list surfaces", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-trusted-agent-smoke-test-"));
  try {
    await writeFile(path.join(runtimeDir, "memory-agent-audit.json"), JSON.stringify({
      ok: true,
      active_agents: 2,
      active_grants: 3,
      agents: [
        { agent_id: "codex-main", permissions: ["memory:read", "memory:write"] },
        { agent_id: "claude-code-main", permissions: ["memory:read"] },
      ],
      grants: [
        { agent_id: "codex-main", scope_type: "project", scope_id: "memory-xx", permissions: ["memory:read", "memory:write"] },
      ],
      policy: {
        admin_token: "human operations only",
      },
    }), "utf8");
    await writeFile(path.join(runtimeDir, "trusted-agent-list.json"), JSON.stringify({
      ok: true,
      trusted_agents: [
        { agent_id: "codex-main", permissions: ["memory:read", "memory:write"], revoked_at: null },
      ],
    }), "utf8");

    const commands: string[] = [];
    const report = await buildTrustedAgentSmokeReport({
      env: {
        MEMORY_XX_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/memory_xx",
        MEMORY_XX_DATABASE_SCHEMA: "memory_xx",
        MEMORY_XX_ADMIN_TOKEN: "admin-token",
      },
      runtimeDir,
      runCommand: async (_name, args, outputFile) => {
        commands.push(args.join(" "));
        return outputFile;
      },
    });

    assert.equal(report.ok, true);
    assert.deepEqual(report.checked_capabilities, ["trusted_agent_tools"]);
    assert.equal(report.results.trusted_agent_tools?.ok, true);
    assert.equal(report.results.trusted_agent_tools?.degraded, true);
    assert.equal(report.degraded, true);
    assert.deepEqual(report.blockers, []);
    assert.equal(commands.some((command) => /\bcreate\b|\bgrant\b|\brevoke-grant\b/u.test(command)), false);
    assert.equal(commands.some((command) => command.includes("--add") || command.includes("--remove")), false);
    assert.equal(commands.some((command) => command.includes("--env-file")), false);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
