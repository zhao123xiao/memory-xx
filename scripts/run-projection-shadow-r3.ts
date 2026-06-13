import { promises as fs } from "node:fs";
import path from "node:path";
import { Pool } from "pg";

import {
  InMemoryMigrationAuditRepository,
  InMemoryProjectionDataSource,
  ProjectionJobType,
  ProjectionRunner,
  ProjectionRunnerRuntimeAdapter,
  ProjectionShadowCompareHarness,
  ProjectionView,
  ScopeType,
  captureProjectionSnapshot,
  createPostgresPoolConfig,
  loadMemoryXXPostgresConfig,
  type ProjectionJob,
  type ProjectionRecord,
  type ProjectionView as ProjectionViewType
} from "../app";

type NormalizedRecord = {
  record_id: string;
  scope_type: string;
  scope_id: string;
  content: string;
  title: string | null;
  summary: string | null;
  metadata: Record<string, any>;
  lifecycle_status: any;
  review_state: any;
  is_current: boolean;
  created_at: string;
  updated_at: string;
  decision: "allow" | "hold" | "exclude";
};

type CaseDef = {
  caseId: string;
  view: ProjectionViewType;
  selectedIds: string[];
};

function mapCategoryToPrimaryView(category: string | undefined): ProjectionView | undefined {
  switch (category) {
    case "decisions":
      return ProjectionView.Decisions;
    case "projects":
      return ProjectionView.Projects;
    case "todos":
      return ProjectionView.Todos;
    case "daily-log":
      return ProjectionView.Daily;
    case "preferences":
    case "constraints":
    case "facts":
    case "lessons":
    case "relationships":
    case "summaries":
    case "memory-index":
      return ProjectionView.Overview;
    default:
      return undefined;
  }
}

function parseOccurredAt(recordId: string, createdAt: string): string | undefined {
  const match = /^log:(\d{4}-\d{2}-\d{2}):/u.exec(recordId);
  if (match) {
    return `${match[1]}T00:00:00.000Z`;
  }
  return createdAt;
}

function mapNormalizedRecordToProjection(row: NormalizedRecord): ProjectionRecord {
  const metadata = row.metadata ?? {};
  const category = metadata.category as string | undefined;
  const primaryView = mapCategoryToPrimaryView(category);
  const tags = Array.isArray(metadata.tags)
    ? metadata.tags.filter((item): item is string => typeof item === "string")
    : undefined;

  return {
    recordId: row.record_id,
    scope: row.scope_type as ScopeType,
    lifecycleStatus: row.lifecycle_status,
    reviewState: row.review_state,
    isCurrent: row.is_current,
    title: row.title ?? row.record_id,
    body: row.content,
    summary: row.summary ?? undefined,
    sourceRecordIds: [row.record_id],
    tags,
    primaryView,
    projectKey: row.scope_type === "project" ? row.scope_id : undefined,
    occurredAt: category === "daily-log" ? parseOccurredAt(row.record_id, row.created_at) : undefined,
    dueDate: category === "todos" ? row.updated_at : undefined,
    decisionDate: category === "decisions" ? row.updated_at : undefined,
    archivedAt: row.lifecycle_status === "archived" || row.lifecycle_status === "tombstone" ? row.updated_at : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    statePriority: category === "todos" ? 1 : undefined,
    archiveBucket:
      row.lifecycle_status === "archived" || row.lifecycle_status === "tombstone"
        ? String(row.lifecycle_status)
        : undefined
  };
}

async function loadBatchRows(batchDir: string): Promise<Map<string, NormalizedRecord>> {
  const rows = (await fs.readFile(path.join(batchDir, "normalized-records.jsonl"), "utf8"))
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as NormalizedRecord)
    .filter((row) => row.decision === "allow");
  return new Map(rows.map((row) => [row.record_id, row]));
}

class FilteredPostgresProjectionDataSource {
  constructor(
    private readonly pool: Pool,
    private readonly schema: string,
    private readonly selectedIds: readonly string[]
  ) {}

  private async loadRows(): Promise<NormalizedRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM "${this.schema}".memory_records WHERE id = ANY($1::text[]) ORDER BY created_at ASC`,
      [this.selectedIds]
    );
    return result.rows.map((row: any) => ({
      record_id: row.id,
      scope_type: row.scope_type,
      scope_id: row.scope_id,
      content: row.content,
      title: row.title,
      summary: row.summary,
      metadata: row.metadata ?? {},
      lifecycle_status: row.lifecycle_status,
      review_state: row.review_state,
      is_current: row.is_current,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      decision: "allow"
    }));
  }

  async getRecord(recordId: string): Promise<ProjectionRecord | undefined> {
    const rows = await this.loadRows();
    const row = rows.find((item) => item.record_id === recordId);
    return row ? mapNormalizedRecordToProjection(row) : undefined;
  }

  async getRecordsForView(view: ProjectionView): Promise<ProjectionRecord[]> {
    const rows = await this.loadRows();
    return rows.map(mapNormalizedRecordToProjection).filter((record) => {
      const categoryView = record.primaryView;
      if (
        (record.lifecycleStatus === "archived" || record.lifecycleStatus === "tombstone") &&
        view === ProjectionView.Archive
      ) {
        return true;
      }
      return categoryView === view;
    });
  }

  async getAllRecords(): Promise<ProjectionRecord[]> {
    const rows = await this.loadRows();
    return rows.map(mapNormalizedRecordToProjection);
  }

  async getRecordsByIds(ids: readonly string[]): Promise<ProjectionRecord[]> {
    const all = await this.getAllRecords();
    const idSet = new Set(ids);
    return all.filter((record) => idSet.has(record.recordId));
  }
}

async function buildBaselineSnapshot(
  records: ProjectionRecord[],
  view: ProjectionView
): Promise<{ files: Record<string, string> }> {
  const root = await fs.mkdtemp(path.join("/tmp", `m4-baseline-${view}-`));
  try {
    const runner = new ProjectionRunner(new InMemoryProjectionDataSource(records), root);
    await runner.run({
      jobId: `baseline-${view}`,
      type: ProjectionJobType.FullRebuild,
      requestedAt: new Date().toISOString(),
      triggeredBy: "baseline",
      views: [view]
    } as ProjectionJob);
    return (await captureProjectionSnapshot(root)) as { files: Record<string, string> };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const batchDirArg = process.argv[2];
  const outputDirArg = process.argv[3];
  if (!batchDirArg || !outputDirArg) {
    throw new Error("Usage: tsx scripts/run-projection-shadow-r3.ts <batch-dir> <output-dir>");
  }

  const batchDir = path.resolve(process.cwd(), batchDirArg);
  const outputDir = path.resolve(process.cwd(), outputDirArg);
  await fs.mkdir(outputDir, { recursive: true });

  const rowMap = await loadBatchRows(batchDir);
  const config = loadMemoryXXPostgresConfig(process.env);
  const pool = new Pool(createPostgresPoolConfig(config));
  const auditRepository = new InMemoryMigrationAuditRepository();
  const runId = `projection-shadow-r3-${new Date().toISOString()}`;

  const caseDefs: CaseDef[] = [
    { caseId: "m4-overview-profile-truth-first", view: ProjectionView.Overview, selectedIds: ["profile_truth_first"] },
    { caseId: "m4-decision-markdown-source-of-truth", view: ProjectionView.Decisions, selectedIds: ["decision_markdown_source_of_truth"] },
    { caseId: "m4-project-memory-system-status", view: ProjectionView.Projects, selectedIds: ["03cd0aad1526249f32c45b538660c1275177e802"] },
    { caseId: "m4-todo-regression-gap", view: ProjectionView.Todos, selectedIds: ["005255d01c845a4358264878f8598b415308e657"] },
    { caseId: "m4-daily-governance-bridge", view: ProjectionView.Daily, selectedIds: ["log:2026-03-19:governance-round4a-bridge:d8c6d04903b2"] },
    { caseId: "m4-archive-mem0-error-tracking", view: ProjectionView.Archive, selectedIds: ["07722c4d0d486d76526c10ca56cf22c22217f8ad"] }
  ];

  const projectionCases = [] as any[];
  for (const def of caseDefs) {
    const baselineRecords = def.selectedIds
      .map((id) => rowMap.get(id))
      .filter((row): row is NormalizedRecord => Boolean(row))
      .map(mapNormalizedRecordToProjection);
    const expectedLegacy = await buildBaselineSnapshot(baselineRecords, def.view);
    projectionCases.push({
      caseId: def.caseId,
      job: {
        jobId: def.caseId,
        type: ProjectionJobType.FullRebuild,
        requestedAt: new Date().toISOString(),
        triggeredBy: "memory-xx",
        views: [def.view],
        reason: JSON.stringify({ selectedIds: def.selectedIds })
      },
      expectedLegacy
    });
  }

  const outputRootDir = path.join(outputDir, "projection-output");
  const candidateRuntime = {
    async run(job: ProjectionJob) {
      const def = caseDefs.find((item) => item.caseId === job.jobId);
      if (!def) {
        throw new Error(`No projection case definition for ${job.jobId}`);
      }
      const dataSource = new FilteredPostgresProjectionDataSource(pool, config.schema, def.selectedIds);
      const runner = new ProjectionRunner(dataSource as any, outputRootDir);
      return new ProjectionRunnerRuntimeAdapter(runner).run(job);
    }
  };

  try {
    const harness = new ProjectionShadowCompareHarness({
      runId,
      candidateRuntime,
      outputRootDir,
      auditRepository,
      operator: "memory-xx",
      workerId: "projection-shadow-r3"
    });

    const result = await harness.run(projectionCases);
    const output = {
      runId,
      schema: config.schema,
      batchDir,
      scorecard: result.scorecard,
      auditSummary: result.auditSummary,
      cases: result.cases.map((item) => ({
        caseId: item.caseId,
        passed: item.passed,
        severity: item.severity,
        diffCount: item.diffs.length,
        candidateFiles: Object.keys(item.candidate.files),
        legacyFiles: Object.keys(item.legacy.files),
        diffs: item.diffs
      }))
    };

    await fs.writeFile(
      path.join(outputDir, "m4-projection-shadow-report.json"),
      `${JSON.stringify(output, null, 2)}\n`,
      "utf8"
    );

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
