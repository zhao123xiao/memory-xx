export interface SourceModeStatus {
  readonly ok: boolean;
  readonly source_of_truth: "postgres";
  readonly markdown_role: "review_projection";
  readonly reverse_sync_allowed: false;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly verification?: {
    readonly checked_records: number;
    readonly projected_records: number;
    readonly missing_projection_ids: readonly string[];
    readonly stale_projection_ids: readonly string[];
    readonly drift_count: number;
  };
}

export function getSourceModeStatus(input: {
  readonly verification?: SourceModeStatus["verification"];
} = {}): SourceModeStatus {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (input.verification && input.verification.drift_count > 0) {
    blockers.push(`source_mode_projection_drift:${input.verification.drift_count}`);
  }
  return {
    ok: blockers.length === 0,
    source_of_truth: "postgres",
    markdown_role: "review_projection",
    reverse_sync_allowed: false,
    blockers,
    warnings,
    verification: input.verification,
  };
}
