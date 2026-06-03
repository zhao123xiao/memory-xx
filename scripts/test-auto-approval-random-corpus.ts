#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";

import { evaluateAutoApprovalPolicy, type AutoApprovalDecision, type AutoApprovalPolicyInput } from "../app/governance/auto-approval-policy";

function arg(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function hashSeed(seed: string): number {
  const digest = createHash("sha256").update(seed).digest();
  return digest.readUInt32LE(0);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length) % values.length] as T;
}

interface GeneratedCase {
  readonly name: string;
  readonly case_type: string;
  readonly expected_decision: AutoApprovalDecision;
  readonly expected_blocked?: readonly string[];
  readonly input: AutoApprovalPolicyInput;
}

const base = {
  mode: "write" as const,
  agentId: "codex",
  source: "conversation_ingest",
  trustedAgent: true,
  hasScopeGrant: true,
  candidateOnly: false,
  candidateOnlyReasons: [],
  semanticConflict: false,
  semanticDuplicate: false,
  autoApproveEnabled: true,
  recentApprovedCount: 0,
  operationalBlockers: [],
};

function safeCandidate(runId: string, marker: string, scopeId: string, memoryType: string, topic: string): AutoApprovalPolicyInput["candidate"] {
  return {
    scopeType: "project",
    scopeId,
    memoryType,
    operation: "add",
    conflictAction: "create",
    confidence: 0.96,
    qualityScore: 0.95,
    title: `${topic} ${marker}`,
    content: `memory-xx ${topic} requires trace marker ${marker} for run ${runId}.`,
    metadata: {
      source: "conversation_ingest",
      auto_approval_random_run_id: runId,
      auto_approval_test_case_type: "safe",
    },
  };
}

function generateCase(rng: () => number, runId: string, index: number, scopeId: string, caseType: string): GeneratedCase {
  const marker = `aar-${runId}-${index}-${Math.floor(rng() * 1_000_000).toString(36)}`;
  const memoryType = pick(rng, ["fact", "procedure", "decision", "constraint", "preference"] as const);
  const topic = pick(rng, ["rollback audit", "policy gate", "projection proof", "health guard", "feedback freeze"] as const);
  const candidate = safeCandidate(runId, marker, scopeId, memoryType, topic);
  const common = { ...base, sourceText: candidate.content, candidate };

  if (caseType === "approve") {
    return { name: `${caseType}-${index}`, case_type: caseType, expected_decision: "approve", input: common };
  }
  if (caseType === "question") {
    const content = `刚刚这个自动审批片段是否应该写入？${marker}`;
    return {
      name: `${caseType}-${index}`,
      case_type: caseType,
      expected_decision: "pending",
      expected_blocked: ["question_only"],
      input: { ...common, sourceText: content, candidate: { ...candidate, content, title: `question ${marker}` } },
    };
  }
  if (caseType === "temporary") {
    const content = `temporary test ${marker} do not remember`;
    return {
      name: `${caseType}-${index}`,
      case_type: caseType,
      expected_decision: "pending",
      expected_blocked: ["low_value_or_temporary_content"],
      input: { ...common, sourceText: content, candidate: { ...candidate, content, title: `temporary ${marker}` } },
    };
  }
  if (caseType === "low_value") {
    return {
      name: `${caseType}-${index}`,
      case_type: caseType,
      expected_decision: "pending",
      expected_blocked: ["low_value_or_temporary_content"],
      input: { ...common, sourceText: "继续", candidate: { ...candidate, content: "user:继续", title: `low value ${marker}` } },
    };
  }
  if (caseType === "secret") {
    return {
      name: `${caseType}-${index}`,
      case_type: caseType,
      expected_decision: "pending",
      expected_blocked: ["sensitive_content_detected"],
      input: { ...common, sourceText: `api_key=sk_${marker}1234567890abcdefghijklmnop`, candidate: { ...candidate, content: `api_key=sk_${marker}1234567890abcdefghijklmnop` } },
    };
  }
  if (caseType === "wrong_scope") {
    return {
      name: `${caseType}-${index}`,
      case_type: caseType,
      expected_decision: "pending",
      expected_blocked: ["auto_approval_not_requested"],
      input: { ...common, candidate: { ...candidate, scopeType: "user", scopeId: `user-${marker}` } },
    };
  }
  if (caseType === "workspace_scope") {
    return {
      name: `${caseType}-${index}`,
      case_type: caseType,
      expected_decision: "pending",
      expected_blocked: ["auto_approval_not_requested"],
      input: { ...common, candidate: { ...candidate, scopeType: "workspace", scopeId: `workspace-${marker}`, metadata: { ...candidate.metadata, review_at: new Date(Date.now() + 86400000).toISOString() } } },
    };
  }
  if (caseType === "global_scope") {
    return {
      name: `${caseType}-${index}`,
      case_type: caseType,
      expected_decision: "pending",
      expected_blocked: ["global_scope_default_manual"],
      input: { ...common, candidate: { ...candidate, scopeType: "global", scopeId: "global", memoryType: "fact" } },
    };
  }
  if (caseType === "missing_grant") {
    return {
      name: `${caseType}-${index}`,
      case_type: caseType,
      expected_decision: "pending",
      expected_blocked: ["scope_grant_missing"],
      input: { ...common, hasScopeGrant: false },
    };
  }
  if (caseType === "low_confidence") {
    return {
      name: `${caseType}-${index}`,
      case_type: caseType,
      expected_decision: "pending",
      expected_blocked: ["confidence_below_threshold"],
      input: { ...common, candidate: { ...candidate, confidence: 0.74 } },
    };
  }
  if (caseType === "low_quality") {
    return {
      name: `${caseType}-${index}`,
      case_type: caseType,
      expected_decision: "pending",
      expected_blocked: ["quality_below_threshold"],
      input: { ...common, candidate: { ...candidate, qualityScore: 0.72 } },
    };
  }
  if (caseType === "pii") {
    return {
      name: `${caseType}-${index}`,
      case_type: caseType,
      expected_decision: "pending",
      expected_blocked: ["pii_requires_human_review"],
      input: { ...common, sourceText: `contact email person-${marker}@example.com`, candidate: { ...candidate, content: `contact email person-${marker}@example.com` } },
    };
  }
  if (caseType === "internal_path") {
    return {
      name: `${caseType}-${index}`,
      case_type: caseType,
      expected_decision: "pending",
      expected_blocked: ["internal_path_scope_requires_review"],
      input: { ...common, candidate: { ...candidate, content: `<project-root> marker ${marker}` } },
    };
  }
  if (caseType === "temporal_expired") {
    return {
      name: `${caseType}-${index}`,
      case_type: caseType,
      expected_decision: "pending",
      expected_blocked: ["expired_candidate"],
      input: { ...common, candidate: { ...candidate, metadata: { ...candidate.metadata, expires_at: new Date(Date.now() - 1000).toISOString() } } },
    };
  }
  if (caseType === "update") {
    return {
      name: `${caseType}-${index}`,
      case_type: caseType,
      expected_decision: "pending",
      expected_blocked: ["operation_not_add"],
      input: { ...common, candidate: { ...candidate, operation: "update", conflictAction: "update" } },
    };
  }
  if (caseType === "graph_relation") {
    const entityPath = [`module:${marker}`, `service:projector-${runId}`];
    const relationPath = [`${entityPath[0]} -> depends_on -> ${entityPath[1]}`];
    return {
      name: `${caseType}-${index}`,
      case_type: caseType,
      expected_decision: "approve",
      input: {
        ...common,
        candidate: {
          ...candidate,
          memoryType: "fact",
          content: `module ${marker} depends on projector evidence source ${runId}.`,
          metadata: {
            ...candidate.metadata,
            auto_approval_test_case_type: "graph_relation",
            graph_relation: true,
            graph_evidence: {
              source_uri: `memory-xx-random-corpus:${runId}:${index}`,
              source_evidence: [`content:${marker}`, `run:${runId}`],
              entity_path: entityPath,
              relation_path: relationPath,
              rebuildable: true,
            },
          },
        },
      },
    };
  }
  if (caseType === "graph_relation_missing_evidence") {
    return {
      name: `${caseType}-${index}`,
      case_type: caseType,
      expected_decision: "pending",
      expected_blocked: ["graph_evidence_required"],
      input: {
        ...common,
        candidate: {
          ...candidate,
          memoryType: "fact",
          content: `module ${marker} depends on an unverified graph relation.`,
          metadata: {
            ...candidate.metadata,
            auto_approval_test_case_type: "graph_relation",
            graph_relation: true,
          },
        },
      },
    };
  }
  if (caseType === "self_improvement") {
    return {
      name: `${caseType}-${index}`,
      case_type: caseType,
      expected_decision: "pending",
      expected_blocked: ["self_improvement_report_only"],
      input: { ...common, candidate: { ...candidate, scopeType: "project", scopeId: "memory-xx-self-improvement", memoryType: "ops_proposal", content: `建议自动修复并重启服务 ${marker}.` } },
    };
  }
  return {
    name: `${caseType}-${index}`,
    case_type: caseType,
    expected_decision: "pending",
    expected_blocked: ["semantic_conflict"],
    input: { ...common, semanticConflict: true, candidate: { ...candidate, conflictAction: pick(rng, ["merge", "update", "supersede"] as const) } },
  };
}

async function main(): Promise<void> {
  const cases = Math.max(10, Number.parseInt(arg("cases") || "50", 10) || 50);
  const seed = arg("seed") || randomBytes(16).toString("hex");
  const runId = `aar-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const scopeRaw = arg("scope") || "project:memory-xx";
  const [, scopeId = "memory-xx"] = scopeRaw.split(":");
  const rng = mulberry32(hashSeed(seed));
  const caseTypes = [
    "approve",
    "question",
    "temporary",
    "low_value",
    "secret",
    "wrong_scope",
    "workspace_scope",
    "global_scope",
    "missing_grant",
    "low_confidence",
    "low_quality",
    "pii",
    "internal_path",
    "temporal_expired",
    "update",
    "graph_relation",
    "graph_relation_missing_evidence",
    "self_improvement",
    "conflict",
  ];
  const generated: GeneratedCase[] = [];
  for (let index = 0; index < cases; index += 1) {
    generated.push(generateCase(rng, runId, index, scopeId, caseTypes[index % caseTypes.length] as string));
  }

  const failures: Array<Record<string, unknown>> = [];
  const results = generated.map((item) => {
    const actual = evaluateAutoApprovalPolicy(item.input);
    const blocked = actual.blocked_reasons.join(",");
    if (actual.decision !== item.expected_decision) {
      failures.push({ name: item.name, expected: item.expected_decision, actual: actual.decision, blocked_reasons: actual.blocked_reasons });
    }
    for (const reason of item.expected_blocked ?? []) {
      if (!blocked.includes(reason)) failures.push({ name: item.name, missing_blocked_reason: reason, blocked_reasons: actual.blocked_reasons });
    }
    return {
      name: item.name,
      case_type: item.case_type,
      expected_decision: item.expected_decision,
      actual_decision: actual.decision,
      score: actual.score,
      blocked_reasons: actual.blocked_reasons,
      marker: item.input.candidate.metadata?.auto_approval_random_run_id,
      title: item.input.candidate.title,
      content: item.input.candidate.content,
    };
  });

  const report = {
    ok: failures.length === 0,
    run_id: runId,
    seed,
    scope: scopeRaw,
    total: generated.length,
    passed: generated.length - failures.length,
    failures,
    results,
  };
  const reportDir = join(process.cwd(), "reports", "auto-approval-random-corpus");
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, `auto-approval-random-corpus-${runId}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report, report_path: reportPath }, null, 2)}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
