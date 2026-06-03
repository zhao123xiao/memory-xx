export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
  severity: "critical" | "warning" | "info";
}

export interface CleanupResult {
  performed: boolean;
  resources_cleaned: string[];
  failed: string[];
}

export interface LayerReport {
  ok: boolean;
  run_id: string;
  started_at: string;
  finished_at: string;
  target: string;
  checks: CheckResult[];
  metrics: Record<string, number | string>;
  artifacts: string[];
  cleanup: CleanupResult;
}

export interface SummaryReport {
  ok: boolean;
  run_id: string;
  started_at: string;
  finished_at: string;
  layers: Record<string, LayerReport>;
  overall_checks_total: number;
  overall_checks_passed: number;
  overall_checks_failed: number;
}

export function createEmptyReport(target: string, runId: string): LayerReport {
  return {
    ok: false,
    run_id: runId,
    started_at: new Date().toISOString(),
    finished_at: "",
    target,
    checks: [],
    metrics: {},
    artifacts: [],
    cleanup: { performed: false, resources_cleaned: [], failed: [] },
  };
}

export function finalizeReport(report: LayerReport): LayerReport {
  report.finished_at = new Date().toISOString();
  report.ok = report.checks.every((c) => c.passed || c.severity === "warning" || c.severity === "info");
  return report;
}
