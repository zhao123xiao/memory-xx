#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { evaluateAutoApprovalPolicy, type AutoApprovalDecision, type AutoApprovalPolicyInput } from "../app/governance/auto-approval-policy";

interface CorpusCase {
  readonly name: string;
  readonly expected_decision: AutoApprovalDecision;
  readonly expected_blocked?: readonly string[];
  readonly expected_blocked_absent?: readonly string[];
  readonly input: Partial<AutoApprovalPolicyInput> & {
    readonly candidate: AutoApprovalPolicyInput["candidate"];
  };
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

function readCases(raw: string): CorpusCase[] {
  return raw.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CorpusCase);
}

async function main(): Promise<void> {
  const fixture = join(process.cwd(), "scripts/test-harness/fixtures/auto-approval-corpus.jsonl");
  const cases = readCases(await readFile(fixture, "utf8"));
  const failures: Array<Record<string, unknown>> = [];
  for (const item of cases) {
    const result = evaluateAutoApprovalPolicy({
      ...base,
      ...item.input,
      candidate: item.input.candidate,
    });
    const blocked = result.blocked_reasons.join(",");
    if (result.decision !== item.expected_decision) {
      failures.push({ name: item.name, expected: item.expected_decision, actual: result.decision, blocked_reasons: result.blocked_reasons });
      continue;
    }
    for (const reason of item.expected_blocked ?? []) {
      if (!blocked.includes(reason)) failures.push({ name: item.name, missing_blocked_reason: reason, blocked_reasons: result.blocked_reasons });
    }
    for (const reason of item.expected_blocked_absent ?? []) {
      if (blocked.includes(reason)) failures.push({ name: item.name, unexpected_blocked_reason: reason, blocked_reasons: result.blocked_reasons });
    }
  }
  const report = { ok: failures.length === 0, total: cases.length, passed: cases.length - failures.length, failures };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
