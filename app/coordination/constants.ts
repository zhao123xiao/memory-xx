import { ScopeType } from "../shared";

import {
  CoordinationTaskStatus,
  PresenceState,
  PriorityLane,
  type CoordinationFinalStatus
} from "./types";

export const COORDINATION_KEY_PREFIX = "coord";

export const PRIORITY_LANE_ORDER = [
  PriorityLane.P0Critical,
  PriorityLane.P1High,
  PriorityLane.P2Normal,
  PriorityLane.P3Background
] as const satisfies ReadonlyArray<PriorityLane>;

export const DEFAULT_PRIORITY_LANE = PriorityLane.P2Normal;
export const DEFAULT_LEASE_TTL_MS = 60_000;
export const DEFAULT_PRESENCE_TTL_MS = 30_000;
export const DEFAULT_PRESENCE_STALE_GRACE_MS = 15_000;
export const DEFAULT_SINGLE_FLIGHT_TTL_MS = 120_000;
export const DEFAULT_DEDUPE_WINDOW_MS = 10_000;
export const DEFAULT_RUN_CONTEXT_TTL_MS = 30 * 60_000;
export const DEFAULT_TASK_CONTEXT_TTL_MS = 10 * 60_000;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
export const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;
export const DEFAULT_DISPATCH_IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
export const INITIAL_GENERATION = 0;

export const COORDINATION_TERMINAL_STATUSES = [
  CoordinationTaskStatus.Succeeded,
  CoordinationTaskStatus.FailedFinal,
  CoordinationTaskStatus.Dlq
] as const satisfies ReadonlyArray<CoordinationTaskStatus>;

export const COORDINATION_ACTIVE_STATUSES = [
  CoordinationTaskStatus.Queued,
  CoordinationTaskStatus.Leased,
  CoordinationTaskStatus.Running,
  CoordinationTaskStatus.RetryWait,
  CoordinationTaskStatus.Recovered
] as const satisfies ReadonlyArray<CoordinationTaskStatus>;

export const COORDINATION_FINAL_STATUSES = [
  CoordinationTaskStatus.Succeeded,
  CoordinationTaskStatus.FailedFinal,
  CoordinationTaskStatus.Recovered
] as const satisfies ReadonlyArray<CoordinationFinalStatus>;

export const PRESENCE_LIVE_STATES = [
  PresenceState.Alive,
  PresenceState.Stale
] as const satisfies ReadonlyArray<PresenceState>;

export const COORDINATION_RUNTIME_SCOPE_TYPES = [
  ScopeType.Run,
  ScopeType.Task
] as const satisfies ReadonlyArray<ScopeType>;

export const COORDINATION_LONG_TERM_SCOPE_TYPES = [
  ScopeType.User,
  ScopeType.Project,
  ScopeType.Workspace,
  ScopeType.Global
] as const satisfies ReadonlyArray<ScopeType>;
