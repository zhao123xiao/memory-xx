#!/usr/bin/env tsx
import "./test-harness/config.js";

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readAutoApprovalRuntimeControlsSync } from "../app/governance/auto-approval-runtime-controls.js";
import { buildApprovalCapacityAdvice } from "./control-panel/approval-capacity.js";
import { collectRuntimeSnapshot } from "./control-panel/runtime-snapshot.js";

function command(): "report" | "plan" {
  return process.argv[2] === "plan" ? "plan" : "report";
}

function latestJsonReport(dir: string): Record<string, unknown> | null {
  try {
    const full = join(process.cwd(), dir);
    const files = readdirSync(full)
      .filter((file) => file.endsWith(".json"))
      .map((file) => join(full, file))
      .sort();
    const latest = files.at(-1);
    return latest ? JSON.parse(readFileSync(latest, "utf8")) as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function recommendationSeverity(item: Record<string, unknown>): "info" | "low" | "medium" | "high" {
  if (item.high_risk === true) return "high";
  if (item.gated === true) return "medium";
  if (item.action === "observe") return "info";
  return "low";
}

async function buildReport(): Promise<Record<string, unknown>> {
  const [capacity, snapshot] = await Promise.all([
    buildApprovalCapacityAdvice(),
    collectRuntimeSnapshot({ persist: false }),
  ]);
  const runtimeControls = readAutoApprovalRuntimeControlsSync();
  const latestRandomFull = latestJsonReport("reports/auto-update-random-full");
  const latestFeedbackFreeze = latestJsonReport("reports/auto-approval-feedback-freeze");
  const latestProductionClosure = latestJsonReport("reports/auto-approval-production-closure");
  const recommendations: Record<string, unknown>[] = [];

  for (const profile of capacity.profiles) {
    if (Number(profile.recommended_limit) > Number(profile.current_limit)) {
      recommendations.push({
        action: "raise_auto_approval_hourly_limit",
        profile: profile.profile,
        current_limit: profile.current_limit,
        recommended_limit: profile.recommended_limit,
        gated: true,
        high_risk: profile.profile === "user" || profile.profile === "global",
        reason: profile.reason,
      });
    }
  }
  const closure = snapshot.summary.closure_reasons as Record<string, unknown> | undefined;
  const pending = Number(closure?.pending_candidate_backlog ?? 0);
  if (pending > 20) {
    recommendations.push({
      action: "review_candidate_backlog",
      pending_candidate_backlog: pending,
      gated: false,
      reason: "候选积压超过 20，建议按 blocked reason 分组清理或调优。",
    });
  }
  if (runtimeControls.update_apply.enabled && runtimeControls.update_apply.real_project_apply) {
    recommendations.push({
      action: "observe_project_update_apply",
      gated: false,
      reason: "project:memory-xx guarded update apply 已启用时，应持续观察 rollback/feedback。",
    });
  } else {
    recommendations.push({
      action: "observe",
      gated: false,
      reason: "真实 update apply 未全开；当前保持受控测试和报告模式。",
    });
  }

  const enriched = recommendations.map((item) => ({ ...item, severity: recommendationSeverity(item) }));
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    mode: "report_only",
    capacity,
    runtime_snapshot: {
      status: snapshot.status,
      summary: snapshot.summary,
      metrics: snapshot.metrics,
    },
    latest_reports: {
      auto_update_random_full: latestRandomFull ? { ok: latestRandomFull.ok, run_id: latestRandomFull.run_id, report_path: latestRandomFull.report_path ?? null } : null,
      feedback_freeze: latestFeedbackFreeze ? { ok: latestFeedbackFreeze.ok, run_id: latestFeedbackFreeze.run_id } : null,
      production_closure: latestProductionClosure ? { ok: latestProductionClosure.ok, run_id: latestProductionClosure.run_id } : null,
    },
    recommendations: enriched,
  };
}

async function main(): Promise<void> {
  const report = await buildReport();
  if (command() === "report") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const gatedPlan = {
    ok: true,
    generated_at: new Date().toISOString(),
    mode: "gated_plan_report_only",
    can_apply_automatically: false,
    low_risk_actions: (report.recommendations as Record<string, unknown>[]).filter((item) => item.severity === "low"),
    guarded_actions: (report.recommendations as Record<string, unknown>[]).filter((item) => item.gated === true),
    high_risk_report_only: (report.recommendations as Record<string, unknown>[]).filter((item) => item.high_risk === true),
    blocked_actions: [
      "enable_global_auto_approval",
      "enable_user_update_apply",
      "enable_global_update_apply",
      "enable_merge_apply",
    ],
    source_report: report,
  };
  process.stdout.write(`${JSON.stringify(gatedPlan, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
