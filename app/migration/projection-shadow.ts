import { promises as fs } from "node:fs";
import path from "node:path";

import type { ProjectionJob } from "../projection";
import { createShadowScorecard, maxShadowSeverity } from "./scorecard";
import {
  MigrationAuditStatus,
  MigrationJobType,
  MigrationSourceSystem,
  MigrationStage,
  ShadowDiffCategory,
  ShadowDiffSeverity,
  type MigrationAuditRepositoryPort,
  type ProjectionShadowCase,
  type ProjectionShadowCaseResult,
  type ProjectionShadowCompareResult,
  type ProjectionSnapshot,
  type ProjectionRuntime,
  type ShadowDiff
} from "./types";

async function listFilesRecursively(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(absolutePath)));
      continue;
    }

    if (entry.isFile() && absolutePath.endsWith(".md")) {
      files.push(absolutePath);
    }
  }

  return files;
}

function normalizeProjectionTimestamp(rawValue: string): string | null {
  const unquoted = rawValue.trim().replace(/^['"]|['"]$/g, "");
  const parsed = Date.parse(unquoted);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString();
}

function normalizeProjectionContent(content: string): string {
  return content
    .replace(/^generated_at:\s+.+$/gmu, "generated_at: <normalized-generated-at>")
    .replace(
      /^(due_date|decision_date|occurred_at|archived_at|created_at|updated_at):\s+(.+)$/gmu,
      (_match, field: string, rawValue: string) => {
        const normalized = normalizeProjectionTimestamp(rawValue);
        return normalized ? `${field}: ${normalized}` : `${field}: ${rawValue}`;
      }
    );
}

export async function captureProjectionSnapshot(
  rootDir: string
): Promise<ProjectionSnapshot> {
  const files = await listFilesRecursively(rootDir);
  const snapshotFiles = Object.fromEntries(
    await Promise.all(
      files.map(async (filePath) => [
        path.relative(rootDir, filePath).replace(/\\/g, "/"),
        normalizeProjectionContent(await fs.readFile(filePath, "utf8"))
      ])
    )
  );

  return { files: snapshotFiles };
}

function compareProjectionCase(
  shadowCase: ProjectionShadowCase,
  candidate: ProjectionSnapshot
): ProjectionShadowCaseResult {
  const legacy = shadowCase.expectedLegacy;
  const diffs: ShadowDiff[] = [];
  const legacyFiles = legacy.files;
  const candidateFiles = candidate.files;
  const legacyPaths = new Set(Object.keys(legacyFiles));
  const candidatePaths = new Set(Object.keys(candidateFiles));
  const missingPaths = [...legacyPaths].filter((file) => !candidatePaths.has(file));
  const extraPaths = [...candidatePaths].filter((file) => !legacyPaths.has(file));
  const changedPaths = [...legacyPaths].filter(
    (file) => candidatePaths.has(file) && legacyFiles[file] !== candidateFiles[file]
  );

  if (missingPaths.length > 0 || extraPaths.length > 0 || changedPaths.length > 0) {
    diffs.push({
      category: ShadowDiffCategory.ProjectionMismatch,
      severity:
        missingPaths.length > 0
          ? ShadowDiffSeverity.Critical
          : changedPaths.length > 0
            ? ShadowDiffSeverity.Warning
            : ShadowDiffSeverity.Info,
      code: "projection_snapshot_mismatch",
      summary: "candidate projection snapshot diverged from legacy baseline",
      details: {
        missing_paths: missingPaths,
        extra_paths: extraPaths,
        changed_paths: changedPaths
      }
    });
  }

  return {
    caseId: shadowCase.caseId,
    legacy,
    candidate,
    diffs,
    severity: maxShadowSeverity(diffs.map((diff) => diff.severity)),
    passed: diffs.length === 0
  };
}

export interface ProjectionShadowHarnessOptions {
  readonly runId: string;
  readonly candidateRuntime: ProjectionRuntime;
  readonly outputRootDir: string;
  readonly auditRepository: MigrationAuditRepositoryPort;
  readonly operator?: string;
  readonly workerId?: string;
}

export class ProjectionShadowCompareHarness {
  private readonly options: ProjectionShadowHarnessOptions;

  constructor(options: ProjectionShadowHarnessOptions) {
    this.options = options;
  }

  async run(cases: readonly ProjectionShadowCase[]): Promise<ProjectionShadowCompareResult> {
    const results: ProjectionShadowCaseResult[] = [];

    for (const shadowCase of cases) {
      await this.resetOutputRoot();
      const startedAt = new Date().toISOString();
      await this.options.candidateRuntime.run(shadowCase.job);
      const candidate = await captureProjectionSnapshot(this.options.outputRootDir);
      const result = compareProjectionCase(shadowCase, candidate);
      results.push(result);

      await this.options.auditRepository.append({
        migrationRunId: this.options.runId,
        batchId: shadowCase.caseId,
        stage: MigrationStage.M3,
        jobType: MigrationJobType.ShadowCompare,
        sourceSystem: MigrationSourceSystem.MemoryXX,
        sourceLocator: `projection:${shadowCase.caseId}`,
        targetTableOrAsset: "projection.shadow_compare",
        targetRecordId: shadowCase.caseId,
        status:
          result.passed
            ? MigrationAuditStatus.Succeeded
            : result.severity === ShadowDiffSeverity.Critical
              ? MigrationAuditStatus.Failed
              : MigrationAuditStatus.SucceededWithDiff,
        diffSummary: result.diffs.map((diff) => diff.code).join(",") || undefined,
        rowCountExpected: Object.keys(shadowCase.expectedLegacy.files).length,
        rowCountLoaded: Object.keys(candidate.files).length,
        startedAt,
        operator: this.options.operator,
        workerId: this.options.workerId,
        metadata: {
          expected_files: Object.keys(shadowCase.expectedLegacy.files),
          candidate_files: Object.keys(candidate.files),
          diffs: result.diffs.map((diff) => ({
            category: diff.category,
            severity: diff.severity,
            code: diff.code,
            summary: diff.summary,
            details: diff.details
          }))
        }
      });
    }

    return {
      runId: this.options.runId,
      cases: results,
      scorecard: createShadowScorecard(results)
    };
  }

  private async resetOutputRoot(): Promise<void> {
    await fs.rm(this.options.outputRootDir, { recursive: true, force: true });
    await fs.mkdir(this.options.outputRootDir, { recursive: true });
  }
}

export class ProjectionRunnerRuntimeAdapter implements ProjectionRuntime {
  constructor(
    private readonly runner: { run(job: ProjectionJob): Promise<{ success: boolean; docsWritten: number; docsSkipped: number; docsRemoved: number }> }
  ) {}

  async run(job: ProjectionJob) {
    return this.runner.run(job);
  }
}
