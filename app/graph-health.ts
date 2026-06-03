export interface GraphHealthStatus {
  readonly ok: boolean;
  readonly ready: boolean;
  readonly warnings: readonly string[];
}

export function getGraphHealthStatus(): GraphHealthStatus {
  return { ok: true, ready: true, warnings: [] };
}
