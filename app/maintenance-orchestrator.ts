export interface MaintenanceReport {
  readonly ok: boolean;
  readonly mode: "report" | "auto";
  readonly steps: readonly string[];
  readonly warnings: readonly string[];
}

export function createMaintenanceReport(mode: "report" | "auto" = "report"): MaintenanceReport {
  return { ok: true, mode, steps: [], warnings: [] };
}
