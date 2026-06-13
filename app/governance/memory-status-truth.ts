export interface MemoryStatusTruthInput {
  readonly healthOk: boolean;
  readonly doctorOk: boolean;
  readonly doctorBlockers: readonly unknown[];
  readonly qdrantProjectionOk: boolean;
  readonly qdrantProjectionBodyOk: boolean;
  readonly projectorOk: boolean;
  readonly p1GateOk: boolean;
  readonly runtimeControlsOk?: boolean;
  readonly candidateCurrent: number;
  readonly safeCloseCandidateCurrent?: number;
  readonly humanReviewCandidateCurrent?: number;
  readonly timerProbeOk: boolean;
  readonly runtimeOnly?: boolean;
}

export interface MemoryStatusTruth {
  readonly ok: boolean;
  readonly runtime_ok: boolean;
  readonly governance_ok: boolean;
  readonly systemd_timer_probe_ok: boolean;
  readonly runtime_exit_ok: boolean;
  readonly exit_ok: boolean;
  readonly status_reason: readonly string[];
}

export function buildMemoryStatusTruth(input: MemoryStatusTruthInput): MemoryStatusTruth {
  const runtimeOk = input.healthOk &&
    input.doctorOk &&
    input.doctorBlockers.length === 0 &&
    input.qdrantProjectionOk &&
    input.qdrantProjectionBodyOk &&
    input.projectorOk &&
    input.p1GateOk &&
    input.runtimeControlsOk !== false;
  const governanceBacklog = input.safeCloseCandidateCurrent ?? input.candidateCurrent;
  const governanceOk = governanceBacklog === 0;
  const reasons: string[] = [];
  if (!runtimeOk) reasons.push("runtime_unhealthy");
  if (input.runtimeControlsOk === false) reasons.push("runtime_controls_invalid");
  if (!governanceOk) reasons.push("governance_backlog");
  if (!input.timerProbeOk) reasons.push("timer_probe_unavailable");
  return {
    ok: runtimeOk && governanceOk,
    runtime_ok: runtimeOk,
    governance_ok: governanceOk,
    systemd_timer_probe_ok: input.timerProbeOk,
    runtime_exit_ok: runtimeOk,
    exit_ok: input.runtimeOnly ? runtimeOk : runtimeOk && governanceOk,
    status_reason: reasons,
  };
}
