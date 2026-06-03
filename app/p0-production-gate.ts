import { validateRuntimeConfig } from "./runtime-config-validator";

export interface ProductionGateResult {
  readonly ok: boolean;
  readonly status: "pass" | "degraded" | "fail";
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export function evaluateP0ProductionGate(env: NodeJS.ProcessEnv = process.env): ProductionGateResult {
  const config = validateRuntimeConfig(env);
  return {
    ok: config.blockers.length === 0,
    status: config.blockers.length > 0 ? "fail" : config.warnings.length > 0 ? "degraded" : "pass",
    blockers: config.blockers,
    warnings: config.warnings,
  };
}
