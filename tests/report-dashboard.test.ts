import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { formatReport, type Report } from "../scripts/generate-report";
import { readIntervalSeconds } from "../scripts/memory-dashboard";

const report: Report = {
  generatedAt: "2026-05-20T10:00:00.000Z",
  windowHours: 24,
  silentApprove: {
    fpRate: { current: 0.035, previous: 0.042, delta: -0.007 },
    adoptionRate: { current: 3, previous: 2, delta: 1 },
    byAgent: {},
    byScope: {},
  },
  recall: {
    nullReturnRate: { current: 0.021, previous: 0.018, delta: 0.003 },
    averageDegradeLevel: { current: 0.2, previous: 0.1, delta: 0.1 },
    totalQueries: { current: 10, previous: 8, delta: 2 },
  },
  projector: {
    lagP50Ms: 100,
    lagP90Ms: 200,
    lagP99Ms: 300,
    deadLetterCount: { current: 12, previous: 8, delta: 4 },
    readbackVerifyFailCount: { current: 1, previous: 0, delta: 1 },
  },
  cache: { recallCacheHitRatio: null },
  feedback: {
    totalFeedback: { current: 5, previous: 2, delta: 3 },
    qdrantProjectionLagMs: null,
  },
  alerts: { open: 2, critical: 1, warning: 1 },
};

test("formatReport includes trend comparisons and alert counts", () => {
  const text = formatReport(report);
  assert.match(text, /previous/);
  assert.match(text, /-0\.70pp/);
  assert.match(text, /Alerts open:\s+2/);
});

test("dashboard interval defaults to 60 and clamps to minimum 10 seconds", () => {
  assert.equal(readIntervalSeconds(["node", "script"]), 60);
  assert.equal(readIntervalSeconds(["node", "script", "--interval=5"]), 10);
  assert.equal(readIntervalSeconds(["node", "script", "--interval=30"]), 30);
});

test("Grafana dashboard JSON is parseable and points at core metrics", () => {
  const dashboardPath = existsSync("deploy/grafana/memory-xx-dashboard.json")
    ? "deploy/grafana/memory-xx-dashboard.json"
    : "deploy/grafana/memory-xx-dashboard.json";
  const raw = readFileSync(dashboardPath, "utf-8");
  const dashboard = JSON.parse(raw) as { panels: Array<{ targets?: Array<{ expr?: string }> }> };
  const exprs = dashboard.panels.flatMap((panel) => panel.targets ?? []).map((target) => target.expr ?? "").join("\n");
  assert.match(exprs, /memory_write_quality_gate_distribution_total/);
  assert.match(exprs, /memory_projector_dead_letter_total/);
  assert.match(exprs, /http_requests_total/);
});

test("Prometheus config scrapes /metrics/prometheus", () => {
  const raw = readFileSync("deploy/prometheus/prometheus.yml", "utf-8");
  assert.match(raw, /metrics_path:\s+\/metrics\/prometheus/);
});
