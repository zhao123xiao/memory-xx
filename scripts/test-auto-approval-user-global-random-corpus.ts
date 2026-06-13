#!/usr/bin/env tsx

import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateAutoApprovalPolicy, type AutoApprovalPolicyInput } from "../app/governance/auto-approval-policy";

function arg(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function casesCount(): number {
  const parsed = Number.parseInt(arg("cases") || "200", 10);
  return Number.isFinite(parsed) ? Math.max(20, Math.min(1000, parsed)) : 200;
}

function nextSeed(): string {
  return arg("seed") || `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

function randomToken(seed: string, index: number, label: string): string {
  return `run-${createHash("sha256").update(`${seed}:${index}:${label}`).digest("hex").slice(0, 12)}`;
}

type EnvPatch = Record<string, string | undefined>;

function withEnv<T>(patch: EnvPatch, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
    const value = patch[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function base(input: {
  readonly index: number;
  readonly seed: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly memoryType: string;
  readonly content: string;
  readonly title?: string;
  readonly operation?: string;
  readonly conflictAction?: string;
  readonly confidence?: number;
  readonly qualityScore?: number;
  readonly source?: string;
  readonly candidateOnly?: boolean;
  readonly metadata?: Record<string, unknown>;
}): AutoApprovalPolicyInput {
  const token = randomToken(input.seed, input.index, `${input.scopeType}:${input.scopeId}`);
  return {
    mode: "auto_approve",
    agentId: "codex",
    source: input.source ?? "conversation_ingest",
    sourceText: input.content,
    candidate: {
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      memoryType: input.memoryType,
      operation: input.operation ?? "add",
      conflictAction: input.conflictAction ?? "create",
      confidence: input.confidence ?? 0.985,
      qualityScore: input.qualityScore ?? 0.985,
      title: input.title ?? `long term signal ${token}`,
      content: input.content,
      metadata: {
        source: input.source ?? "conversation_ingest",
        auto_approval_user_global_random_run_id: input.seed,
        random_marker: token,
        ...input.metadata,
      },
    },
    trustedAgent: true,
    hasScopeGrant: true,
    candidateOnly: input.candidateOnly ?? false,
    candidateOnlyReasons: input.candidateOnly ? ["candidate_only_enabled_for_global_safety"] : [],
    semanticConflict: false,
    semanticDuplicate: false,
    autoApproveEnabled: true,
    recentApprovedCount: 0,
  };
}

type TestCase = {
  readonly name: string;
  readonly input: AutoApprovalPolicyInput;
  readonly env: EnvPatch;
  readonly expected: "approve" | "pending";
  readonly expectedReason?: string;
};

function buildCase(index: number, seed: string): TestCase {
  const token = randomToken(seed, index, "case");
  const userScope = `u-${seed.replace(/[^a-z0-9-]/giu, "").slice(0, 14)}-${index}`;
  const globalScope = "global";
  switch (index % 14) {
    case 0:
      return {
        name: "user-test-scope-stable-preference-approve",
        env: { MEMORY_XX_AUTO_APPROVAL_CANARY: "1", MEMORY_XX_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES: `user:${userScope}`, MEMORY_XX_AUTO_APPROVAL_GLOBAL_ENABLED: undefined, MEMORY_XX_AUTO_APPROVAL_USER_IDS: undefined },
        expected: "approve",
        input: base({ index, seed, scopeType: "user", scopeId: userScope, memoryType: "preference", content: `User prefers concise engineering answers with concrete file references marker ${token}.` }),
      };
    case 1:
      return {
        name: "user-real-scope-default-pending",
        env: { MEMORY_XX_AUTO_APPROVAL_CANARY: undefined, MEMORY_XX_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES: undefined, MEMORY_XX_AUTO_APPROVAL_GLOBAL_ENABLED: undefined, MEMORY_XX_AUTO_APPROVAL_USER_IDS: undefined },
        expected: "pending",
        expectedReason: "scope_not_enabled",
        input: base({ index, seed, scopeType: "user", scopeId: "current-user", memoryType: "preference", content: `User prefers compact status reports after long runs marker ${token}.` }),
      };
    case 2:
      return {
        name: "user-test-scope-candidate-only-bypass-approve",
        env: { MEMORY_XX_AUTO_APPROVAL_CANARY: "1", MEMORY_XX_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES: `user:${userScope}`, MEMORY_XX_AUTO_APPROVAL_GLOBAL_ENABLED: undefined },
        expected: "approve",
        input: base({ index, seed, scopeType: "user", scopeId: userScope, memoryType: "constraint", candidateOnly: true, content: `User wants destructive commands to require explicit confirmation marker ${token}.` }),
      };
    case 3:
      return {
        name: "user-low-confidence-pending",
        env: { MEMORY_XX_AUTO_APPROVAL_CANARY: "1", MEMORY_XX_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES: `user:${userScope}` },
        expected: "pending",
        expectedReason: "confidence_below_threshold",
        input: base({ index, seed, scopeType: "user", scopeId: userScope, memoryType: "preference", confidence: 0.72, content: `Maybe the user likes terse outputs marker ${token}.` }),
      };
    case 4:
      return {
        name: "user-question-pending",
        env: { MEMORY_XX_AUTO_APPROVAL_CANARY: "1", MEMORY_XX_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES: `user:${userScope}` },
        expected: "pending",
        expectedReason: "question_only",
        input: base({ index, seed, scopeType: "user", scopeId: userScope, memoryType: "preference", content: `Should the user prefer structured summaries for marker ${token}?` }),
      };
    case 5:
      return {
        name: "user-secret-pending",
        env: { MEMORY_XX_AUTO_APPROVAL_CANARY: "1", MEMORY_XX_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES: `user:${userScope}` },
        expected: "pending",
        expectedReason: "sensitive_content_detected",
        input: base({ index, seed, scopeType: "user", scopeId: userScope, memoryType: "preference", content: `User credential token=sk_${token}${token}${token} should never be stored.` }),
      };
    case 6:
      return {
        name: "user-pii-pending",
        env: { MEMORY_XX_AUTO_APPROVAL_CANARY: "1", MEMORY_XX_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES: `user:${userScope}` },
        expected: "pending",
        expectedReason: "pii_requires_human_review",
        input: base({ index, seed, scopeType: "user", scopeId: userScope, memoryType: "preference", content: `User contact email person-${token}@example.com belongs in review.` }),
      };
    case 7:
      return {
        name: "user-update-signal-pending",
        env: { MEMORY_XX_AUTO_APPROVAL_CANARY: "1", MEMORY_XX_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES: `user:${userScope}` },
        expected: "pending",
        expectedReason: "explicit_update_requires_human_review",
        input: base({ index, seed, scopeType: "user", scopeId: userScope, memoryType: "preference", content: `之前用户喜欢 A-${token}，现在改成 B-${token}。` }),
      };
    case 8:
      return {
        name: "global-default-manual-pending",
        env: { MEMORY_XX_AUTO_APPROVAL_CANARY: undefined, MEMORY_XX_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES: undefined, MEMORY_XX_AUTO_APPROVAL_GLOBAL_ENABLED: undefined },
        expected: "pending",
        expectedReason: "global_scope_default_manual",
        input: base({ index, seed, scopeType: "global", scopeId: globalScope, memoryType: "fact", content: `Global rule candidates remain manual unless explicitly enabled marker ${token}.` }),
      };
    case 9:
      return {
        name: "global-enabled-simulation-approve",
        env: { MEMORY_XX_AUTO_APPROVAL_CANARY: "1", MEMORY_XX_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES: "global:global", MEMORY_XX_AUTO_APPROVAL_GLOBAL_ENABLED: "1" },
        expected: "approve",
        input: base({ index, seed, scopeType: "global", scopeId: globalScope, memoryType: "constraint", content: `Global automation constraint requires audit metadata marker ${token}.` }),
      };
    case 10:
      return {
        name: "global-enabled-secret-pending",
        env: { MEMORY_XX_AUTO_APPROVAL_CANARY: "1", MEMORY_XX_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES: "global:global", MEMORY_XX_AUTO_APPROVAL_GLOBAL_ENABLED: "1" },
        expected: "pending",
        expectedReason: "sensitive_content_detected",
        input: base({ index, seed, scopeType: "global", scopeId: globalScope, memoryType: "constraint", content: `Global token=ghp_${token}${token}${token} must be blocked.` }),
      };
    case 11:
      return {
        name: "global-enabled-low-confidence-pending",
        env: { MEMORY_XX_AUTO_APPROVAL_CANARY: "1", MEMORY_XX_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES: "global:global", MEMORY_XX_AUTO_APPROVAL_GLOBAL_ENABLED: "1" },
        expected: "pending",
        expectedReason: "confidence_below_threshold",
        input: base({ index, seed, scopeType: "global", scopeId: globalScope, memoryType: "fact", confidence: 0.80, qualityScore: 0.99, content: `Global fact uncertain marker ${token}.` }),
      };
    case 12:
      return {
        name: "global-enabled-update-pending",
        env: { MEMORY_XX_AUTO_APPROVAL_CANARY: "1", MEMORY_XX_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES: "global:global", MEMORY_XX_AUTO_APPROVAL_GLOBAL_ENABLED: "1" },
        expected: "pending",
        expectedReason: "explicit_update_requires_human_review",
        input: base({ index, seed, scopeType: "global", scopeId: globalScope, memoryType: "fact", content: `Previously global value was A-${token}; now replace with B-${token}.` }),
      };
    default:
      return {
        name: "global-enabled-candidate-only-bypass-approve",
        env: { MEMORY_XX_AUTO_APPROVAL_CANARY: "1", MEMORY_XX_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES: "global:global", MEMORY_XX_AUTO_APPROVAL_GLOBAL_ENABLED: "1" },
        expected: "approve",
        input: base({ index, seed, scopeType: "global", scopeId: globalScope, memoryType: "procedure", candidateOnly: true, content: `Global procedure requires scoped bypass and grant marker ${token}.` }),
      };
  }
}

async function main(): Promise<void> {
  const seed = nextSeed();
  const runId = `user-global-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const runtimeDir = await mkdtemp(join(tmpdir(), `memory-xx-user-global-corpus-${runId}-`));
  const cases = Array.from({ length: casesCount() }, (_, index) => buildCase(index, seed));
  const failures: Array<Record<string, unknown>> = [];
  try {
    const results = cases.map((item, index) => withEnv({ MEMORY_XX_RUNTIME_DIR: runtimeDir, ...item.env }, () => {
      const actual = evaluateAutoApprovalPolicy(item.input);
      if (actual.decision !== item.expected) {
        failures.push({ index, name: item.name, expected: item.expected, actual: actual.decision, blocked_reasons: actual.blocked_reasons });
      }
      if (item.expectedReason && !actual.blocked_reasons.some((reason) => reason.includes(item.expectedReason ?? ""))) {
        failures.push({ index, name: item.name, missing_reason: item.expectedReason, blocked_reasons: actual.blocked_reasons });
      }
      return {
        index,
        name: item.name,
        scope: `${item.input.candidate.scopeType}:${item.input.candidate.scopeId}`,
        expected: item.expected,
        actual: actual.decision,
        score: actual.score,
        blocked_reasons: actual.blocked_reasons,
        reasons: actual.reasons,
        scope_profile: actual.scope_profile,
        candidate_only_bypassed: actual.candidate_only_bypassed === true,
      };
    }));
    const summary = results.reduce<Record<string, number>>((acc, item) => {
      const key = `${item.name}:${item.actual}`;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    const report = { ok: failures.length === 0, run_id: runId, seed, runtime_dir: runtimeDir, cases: cases.length, failures, summary, results };
    const reportDir = join(process.cwd(), "reports", "auto-approval-user-global-random-corpus");
    await mkdir(reportDir, { recursive: true });
    const reportPath = join(reportDir, `auto-approval-user-global-random-corpus-${runId}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(JSON.stringify({ ...report, report_path: reportPath }, null, 2) + "\n");
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
