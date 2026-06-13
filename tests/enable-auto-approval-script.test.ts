import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluateAutoApprovalPolicy, LifecycleStatus, ReviewState } from "../app";

function withRuntimeDir<T>(callback: (dir: string) => T): T {
  const previousRuntimeDir = process.env.MEMORY_XX_RUNTIME_DIR;
  const dir = mkdtempSync(path.join(tmpdir(), "memory-xx-auto-approval-admin-"));
  process.env.MEMORY_XX_RUNTIME_DIR = dir;
  try {
    return callback(dir);
  } finally {
    if (previousRuntimeDir === undefined) delete process.env.MEMORY_XX_RUNTIME_DIR;
    else process.env.MEMORY_XX_RUNTIME_DIR = previousRuntimeDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("admin enable-auto-approval script enables a project scope with confidence threshold", () => withRuntimeDir((dir) => {
  const output = execFileSync("node", [
    "--import",
    "tsx",
    "scripts/admin/enable-auto-approval.ts",
    "--scope-id=project-alpha",
    "--threshold=0.88",
    "--agent=codex",
  ], {
    cwd: process.cwd(),
    env: { ...process.env, MEMORY_XX_RUNTIME_DIR: dir },
    encoding: "utf8",
  });
  const result = JSON.parse(output) as { ok?: boolean; scope?: string; threshold?: number };
  assert.equal(result.ok, true);
  assert.equal(result.scope, "project:project-alpha");
  assert.equal(result.threshold, 0.88);

  const config = JSON.parse(readFileSync(path.join(dir, "auto-approval-scope-enablements.json"), "utf8")) as {
    enabled_scopes?: unknown;
    enablements?: Array<{ scope?: string; allowed_sources?: string[]; confidence_threshold?: number }>;
  };
  assert.deepEqual(config.enabled_scopes, ["project:project-alpha"]);
  assert.equal(config.enablements?.[0]?.scope, "project:project-alpha");
  assert.deepEqual(config.enablements?.[0]?.allowed_sources, ["conversation_ingest"]);
  assert.equal(config.enablements?.[0]?.confidence_threshold, 0.88);

  const policy = evaluateAutoApprovalPolicy({
    mode: "write",
    agentId: "codex",
    source: "conversation_ingest",
    sourceText: "请记住：project-alpha 的部署流程要求先跑 typecheck。",
    candidate: {
      scopeType: "project",
      scopeId: "project-alpha",
      memoryType: "procedure",
      operation: "add",
      conflictAction: "create",
      confidence: 0.89,
      qualityScore: 0.94,
      title: "project alpha deploy procedure",
      content: "project-alpha 的部署流程要求先跑 typecheck。",
      metadata: { source: "conversation_ingest" },
    },
    trustedAgent: true,
    hasScopeGrant: true,
    candidateOnly: true,
    candidateOnlyReasons: ["candidate_only_mode"],
    semanticConflict: false,
    semanticDuplicate: false,
    autoApproveEnabled: true,
    recentApprovedCount: 0,
  });
  assert.equal(policy.decision, "approve");
  assert.equal(policy.lifecycleStatus, LifecycleStatus.Approved);
  assert.equal(policy.reviewState, ReviewState.SilentApproved);
  assert.equal(policy.thresholds.confidence, 0.88);

  const wrongSource = evaluateAutoApprovalPolicy({
    ...policyInput("smart_write"),
    sourceText: "请记住：project-alpha 的部署流程要求先跑 lint。",
    candidate: {
      scopeType: "project",
      scopeId: "project-alpha",
      memoryType: "procedure",
      operation: "add",
      conflictAction: "create",
      confidence: 0.99,
      qualityScore: 0.99,
      title: "project alpha deploy lint",
      content: "project-alpha 的部署流程要求先跑 lint。",
      metadata: { source: "smart_write" },
    },
  });
  assert.equal(wrongSource.decision, "pending");
  assert.match(wrongSource.blocked_reasons.join(","), /source_not_enabled_for_scope/u);
}));

function policyInput(source: string): Parameters<typeof evaluateAutoApprovalPolicy>[0] {
  return {
    mode: "write",
    agentId: "codex",
    source,
    sourceText: "请记住：project-alpha 的部署流程要求先跑 typecheck。",
    candidate: {
      scopeType: "project",
      scopeId: "project-alpha",
      memoryType: "procedure",
      operation: "add",
      conflictAction: "create",
      confidence: 0.89,
      qualityScore: 0.94,
      title: "project alpha deploy procedure",
      content: "project-alpha 的部署流程要求先跑 typecheck。",
      metadata: { source },
    },
    trustedAgent: true,
    hasScopeGrant: true,
    candidateOnly: true,
    candidateOnlyReasons: ["candidate_only_mode"],
    semanticConflict: false,
    semanticDuplicate: false,
    autoApproveEnabled: true,
    recentApprovedCount: 0,
  };
}
