export enum WriteErrorCode {
  InvalidScopeType = "invalid_scope_type",
  InvalidCreateState = "invalid_create_state",
  InvalidLifecycleTransition = "invalid_lifecycle_transition",
  InvalidInput = "invalid_input",
  RequestPayloadConflict = "request_payload_conflict",
  RequestAlreadyInFlight = "request_already_in_flight",
  RequestAlreadyFailed = "request_already_failed",
  ScopeFrozen = "scope_frozen",
  RecordNotFound = "record_not_found",
  RelationTargetNotFound = "relation_target_not_found",
  TransactionConstraintViolation = "transaction_constraint_violation"
}

export class WriteError extends Error {
  readonly code: WriteErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: WriteErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export class InvalidInputError extends WriteError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(WriteErrorCode.InvalidInput, message, details);
  }
}

export class InvalidScopeTypeError extends WriteError {
  constructor(scopeType: string) {
    super(WriteErrorCode.InvalidScopeType, `Scope type ${scopeType} cannot be stored in the long-term ledger.`, {
      scopeType
    });
  }
}

export class InvalidCreateStateError extends WriteError {
  constructor(details: Record<string, unknown>) {
    super(
      WriteErrorCode.InvalidCreateState,
      "Create-memory commands must use candidate+pending or approved+(approved|not_required).",
      details
    );
  }
}

export class InvalidLifecycleTransitionError extends WriteError {
  constructor(
    action: string,
    memoryId: string,
    lifecycleStatus: string,
    reviewState: string,
    isCurrent: boolean
  ) {
    super(
      WriteErrorCode.InvalidLifecycleTransition,
      `Memory ${memoryId} cannot apply ${action} from ${lifecycleStatus}/${reviewState} (isCurrent=${String(isCurrent)}).`,
      {
        action,
        memoryId,
        lifecycleStatus,
        reviewState,
        isCurrent
      }
    );
  }
}

export class RequestPayloadConflictError extends WriteError {
  constructor(requestId: string) {
    super(
      WriteErrorCode.RequestPayloadConflict,
      `Request ${requestId} was already seen with a different payload hash.`,
      { requestId }
    );
  }
}

export class RequestAlreadyInFlightError extends WriteError {
  constructor(requestId: string) {
    super(
      WriteErrorCode.RequestAlreadyInFlight,
      `Request ${requestId} is already being processed.`,
      { requestId }
    );
  }
}

export class RequestAlreadyFailedError extends WriteError {
  constructor(requestId: string) {
    super(
      WriteErrorCode.RequestAlreadyFailed,
      `Request ${requestId} previously failed and cannot be replayed automatically.`,
      { requestId }
    );
  }
}

export class RecordNotFoundError extends WriteError {
  constructor(memoryId: string) {
    super(WriteErrorCode.RecordNotFound, `Memory record ${memoryId} was not found.`, {
      memoryId
    });
  }
}

export class RelationTargetNotFoundError extends WriteError {
  constructor(targetMemoryId: string) {
    super(
      WriteErrorCode.RelationTargetNotFound,
      `Relation target ${targetMemoryId} was not found.`,
      { targetMemoryId }
    );
  }
}

export class TransactionConstraintViolationError extends WriteError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(WriteErrorCode.TransactionConstraintViolation, message, details);
  }
}
