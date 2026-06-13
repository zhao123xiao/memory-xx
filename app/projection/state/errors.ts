export enum ProjectionErrorCode {
  DataMissing = "data_missing",
  TemplateInvalid = "template_invalid",
  WriteFailed = "write_failed",
  StateCommitFailed = "state_commit_failed",
  VisibilityDenied = "visibility_denied",
  InvalidPath = "invalid_path"
}

export const PROJECTION_ERROR_CODES = [
  ProjectionErrorCode.DataMissing,
  ProjectionErrorCode.TemplateInvalid,
  ProjectionErrorCode.WriteFailed,
  ProjectionErrorCode.StateCommitFailed,
  ProjectionErrorCode.VisibilityDenied,
  ProjectionErrorCode.InvalidPath
] as const satisfies ReadonlyArray<ProjectionErrorCode>;

export interface ProjectionErrorDetails {
  readonly message: string;
  readonly retriable: boolean;
  readonly context?: Readonly<Record<string, string | number | boolean>>;
}

export class ProjectionError extends Error {
  readonly code: ProjectionErrorCode;
  readonly retriable: boolean;
  readonly context?: Readonly<Record<string, string | number | boolean>>;

  constructor(code: ProjectionErrorCode, details: ProjectionErrorDetails, options?: ErrorOptions) {
    super(details.message, options);
    this.name = "ProjectionError";
    this.code = code;
    this.retriable = details.retriable;
    this.context = details.context;
  }
}

export function isProjectionErrorCode(value: string): value is ProjectionErrorCode {
  return PROJECTION_ERROR_CODES.includes(value as ProjectionErrorCode);
}

export function toProjectionError(
  code: ProjectionErrorCode,
  message: string,
  retriable = false,
  context?: Readonly<Record<string, string | number | boolean>>,
  cause?: unknown
): ProjectionError {
  return new ProjectionError(code, { message, retriable, context }, { cause });
}
