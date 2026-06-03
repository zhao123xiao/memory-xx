import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAutoApprovalPolicy } from "../app/governance/auto-approval-policy";
import type { JsonObject } from "../app/shared/types";

function base(metadata: JsonObject) {
  return {
    mode: "auto_approve" as const,
    agentId: "codex",
    source: "conversation_ingest",
    trustedAgent: true,
    hasScopeGrant: true,
    candidateOnly: false,
    candidateOnlyReasons: [],
    semanticConflict: false,
    semanticDuplicate: false,
    autoApproveEnabled: true,
    enabledProjectIds: ["memory-xx"],
    recentApprovedCount: 0,
    candidate: {
      scopeType: "project",
      scopeId: "memory-xx",
      memoryType: "fact",
      operation: "add",
      confidence: 0.99,
      qualityScore: 0.99,
      content: "memory-xx graph production relation evidence gate",
      metadata,
    },
  };
}

test("graph relation auto approval requires rebuildable evidence", () => {
  const missing = evaluateAutoApprovalPolicy(base({ graph_relation: true }));
  assert.equal(missing.decision, "pending");
  assert.ok(missing.blocked_reasons.includes("graph_evidence_required"));
  assert.ok(missing.blocked_reasons.includes("graph_relation_not_rebuildable"));

  const withEvidence = evaluateAutoApprovalPolicy(base({
    graph_relation: true,
    graph_evidence: {
      source_uri: "memory-xx://test/graph-production",
      entity_path: ["memory-xx", "Qdrant"],
      relation_path: ["uses"],
      source_evidence: ["memory-xx uses Qdrant for vector projection"],
      rebuildable: true,
    },
  }));
  assert.equal(withEvidence.decision, "approve");
  assert.equal(withEvidence.graph?.blocked, false);
});
