import type { CoordinationFailure } from "./types";

export class CoordinationError extends Error {
  readonly code: string;
  readonly retriable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    options?: {
      retriable?: boolean;
      details?: Readonly<Record<string, unknown>>;
      cause?: unknown;
    }
  ) {
    super(message);
    this.name = "CoordinationError";
    this.code = code;
    this.retriable = options?.retriable ?? false;
    this.details = options?.details;
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export class TaskNotFoundError extends CoordinationError {
  constructor(taskId: string) {
    super("coord_task_not_found", `Coordination task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

export class LeaseRejectedError extends CoordinationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super("coord_lease_rejected", message, {
      retriable: false,
      details
    });
    this.name = "LeaseRejectedError";
  }
}

export class LockConflictError extends CoordinationError {
  constructor(resourceId: string, details?: Readonly<Record<string, unknown>>) {
    super("coord_lock_conflict", `Distributed lock already held for ${resourceId}`, {
      retriable: true,
      details
    });
    this.name = "LockConflictError";
  }
}

export class FencingTokenRejectedError extends CoordinationError {
  constructor(resourceId: string, token: number) {
    super(
      "coord_fencing_rejected",
      `Fencing token ${token} is no longer current for ${resourceId}`,
      {
        retriable: false,
        details: { resourceId, token }
      }
    );
    this.name = "FencingTokenRejectedError";
  }
}

export class PresenceUnavailableError extends CoordinationError {
  constructor(workerId: string) {
    super(
      "coord_presence_unavailable",
      `Worker presence is not alive for ${workerId}`,
      {
        retriable: true,
        details: { workerId }
      }
    );
    this.name = "PresenceUnavailableError";
  }
}

export function coordinationFailureFromError(
  error: unknown,
  defaults?: Partial<CoordinationFailure>
): CoordinationFailure {
  if (error instanceof CoordinationError) {
    return {
      code: error.code,
      message: error.message,
      retriable: error.retriable,
      details: error.details
    };
  }

  if (error instanceof Error) {
    return {
      code: defaults?.code ?? "coord_unhandled_error",
      message: error.message,
      retriable: defaults?.retriable ?? false,
      details: defaults?.details
    };
  }

  return {
    code: defaults?.code ?? "coord_unknown_error",
    message: defaults?.message ?? "Unknown coordination failure",
    retriable: defaults?.retriable ?? false,
    details: defaults?.details
  };
}
