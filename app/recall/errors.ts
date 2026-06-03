export enum RecallErrorCode {
  InvalidScopeContext = "invalid_scope_context",
  ScopeForbidden = "scope_forbidden",
  InvalidFilterMode = "invalid_filter_mode",
  QueryEmpty = "query_empty",
  BackendTimeout = "backend_timeout",
  BackendUnavailable = "backend_unavailable"
}

const STATUS_BY_CODE: Record<RecallErrorCode, number> = {
  [RecallErrorCode.InvalidScopeContext]: 400,
  [RecallErrorCode.ScopeForbidden]: 403,
  [RecallErrorCode.InvalidFilterMode]: 400,
  [RecallErrorCode.QueryEmpty]: 400,
  [RecallErrorCode.BackendTimeout]: 504,
  [RecallErrorCode.BackendUnavailable]: 503
};

export class RecallError extends Error {
  readonly code: RecallErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: RecallErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "RecallError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export interface RecallErrorResponseBody {
  error: {
    code: RecallErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export function isRecallError(error: unknown): error is RecallError {
  return error instanceof RecallError;
}

export function toRecallErrorResponseBody(
  error: RecallError
): RecallErrorResponseBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      details: error.details
    }
  };
}
