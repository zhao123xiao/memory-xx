import { promises as fs } from "node:fs";
import path from "node:path";

import { PROJECTION_ROOT_DIR, PROJECTION_VIEW_DIRECTORIES } from "./constants";
import { type ProjectionDataSource } from "./data-source";
import { classifyRecordToViews, audienceForView } from "./mapper/classify-record";
import { sortProjectionItems } from "./mapper/stable-sort";
import { type AffectedProjectionDoc, planFullRebuild, planIncrementalExport, planScopedRebuild } from "./planner";
import { resolveProjectionPath } from "./writer/path-resolver";
import { writeDocumentIfChanged } from "./writer/diff-guard";
import { renderMarkdownDocument } from "./writer/render-markdown-document";
import { serializeFrontmatter } from "./writer/frontmatter";
import { buildStableProjectionId } from "./mapper/stable-id";
import {
  ExporterStateRepository,
  type ExporterRecordStateSnapshot,
  type ExporterStateFile,
  type ExporterViewStateSnapshot
} from "./state/state-repository";
import {
  ProjectionAggregationGrain,
  ProjectionAudience,
  ProjectionDocumentKind,
  ProjectionView,
  type ProjectionJob,
  ProjectionJobType,
  type ProjectionRecord
} from "./types";
import { createArchiveTemplate } from "./templates/archive";
import { createDailyTemplate } from "./templates/daily";
import { createDecisionTemplate } from "./templates/decisions";
import { createGovernanceTemplate } from "./templates/governance";
import { createOverviewTemplate } from "./templates/overview";
import { createProjectTemplate } from "./templates/projects";
import { createTodoTemplate } from "./templates/todos";
import { PROJECTION_EXPORTER_VERSION } from "./constants";

// ── Execution result ────────────────────────────────────────────────

export interface ExportExecutionResult {
  readonly jobId: string;
  readonly success: boolean;
  readonly docsWritten: number;
  readonly docsSkipped: number;
  readonly docsRemoved: number;
  readonly errors: readonly ExportExecutionError[];
  readonly durationMs: number;
}

export interface ExportExecutionError {
  readonly stableId: string;
  readonly message: string;
}

interface ProjectionStatePatch {
  readonly views: ExporterStateFile["views"];
  readonly records: ExporterStateFile["records"];
}

interface PlanExecutionResult {
  readonly docsWritten: number;
  readonly docsSkipped: number;
  readonly docsRemoved: number;
  readonly statePatch?: ProjectionStatePatch;
}

// ── Template dispatch ───────────────────────────────────────────────

function templateForView(view: ProjectionView, record: ProjectionRecord) {
  switch (view) {
    case ProjectionView.Overview: return createOverviewTemplate(record);
    case ProjectionView.Decisions: return createDecisionTemplate(record);
    case ProjectionView.Projects: return createProjectTemplate(record);
    case ProjectionView.Todos: return createTodoTemplate(record);
    case ProjectionView.Daily: return createDailyTemplate(record);
    case ProjectionView.Governance: return createGovernanceTemplate(record);
    case ProjectionView.Archive: return createArchiveTemplate(record);
  }
}

// ── Index page renderer ─────────────────────────────────────────────

function renderIndexPage(
  view: ProjectionView,
  records: readonly ProjectionRecord[]
): string {
  const sortable = records.map((r) => ({
    stableId: buildStableProjectionId({
      view,
      grain: ProjectionAggregationGrain.Record,
      keyParts: [r.recordId]
    }),
    title: r.title,
    updatedAt: r.updatedAt,
    weight: r.weight,
    decisionDate: r.decisionDate,
    dueDate: r.dueDate,
    occurredAt: r.occurredAt,
    submittedAt: r.submittedAt,
    archivedAt: r.archivedAt,
    projectKey: r.projectKey,
    queue: r.queue,
    archiveBucket: r.archiveBucket,
    statePriority: r.statePriority,
  }));
  const sorted = sortProjectionItems(view, sortable);

  const lines: string[] = [];
  for (const item of sorted) {
    const lastPart = item.stableId.split(":").pop() ?? item.stableId;
    lines.push(`- [[${item.title ?? lastPart}]]`);
  }

  const indexStableId = buildStableProjectionId({
    view,
    grain: ProjectionAggregationGrain.Index,
    keyParts: ["index"]
  });

  const frontmatter: Record<string, any> = {
    projection_id: indexStableId,
    view,
    title: `${view.charAt(0).toUpperCase() + view.slice(1)} Index`,
    document_kind: ProjectionDocumentKind.Index,
    generated_at: new Date().toISOString(),
    exporter_version: PROJECTION_EXPORTER_VERSION,
    visibility: audienceForView(view, records[0] ?? {
      recordId: "",
      scope: "user" as any,
      lifecycleStatus: "approved" as any,
      reviewState: "approved" as any,
      isCurrent: true,
      title: ""
    }),
  };

  const doc = [
    serializeFrontmatter(frontmatter),
    `# ${view.charAt(0).toUpperCase() + view.slice(1)} Index`,
    "",
    lines.length > 0 ? lines.join("\n") : "No entries.",
  ].join("\n");

  return doc.endsWith("\n") ? doc : `${doc}\n`;
}

// ── Runner ──────────────────────────────────────────────────────────

export class ProjectionRunner {
  private readonly stateRepo: ExporterStateRepository;

  constructor(
    private readonly dataSource: ProjectionDataSource,
    private readonly rootDir: string = PROJECTION_ROOT_DIR
  ) {
    this.stateRepo = new ExporterStateRepository(rootDir);
  }

  /**
   * Execute a projection job (incremental / scoped-rebuild / full-rebuild).
   */
  async run(job: ProjectionJob): Promise<ExportExecutionResult> {
    const start = Date.now();
    const errors: ExportExecutionError[] = [];
    let docsWritten = 0;
    let docsSkipped = 0;
    let docsRemoved = 0;

    try {
      await this.stateRepo.startJob(job);

      switch (job.type) {
        case ProjectionJobType.IncrementalExport:
          ({ docsWritten, docsSkipped, docsRemoved } = await this.runIncremental(job, errors));
          break;
        case ProjectionJobType.ScopedRebuild:
          ({ docsWritten, docsSkipped, docsRemoved } = await this.runScopedRebuild(job, errors));
          break;
        case ProjectionJobType.FullRebuild:
          ({ docsWritten, docsSkipped, docsRemoved } = await this.runFullRebuild(job, errors));
          break;
      }

      const statePatch = await this.buildCompletionStatePatch(job);
      const success = errors.length === 0;
      await this.stateRepo.markJobCompleted(job.jobId, success, success
        ? statePatch
        : { failureSummary: errors.map((error) => `${error.stableId}: ${error.message}`).join("; ") });
      return { jobId: job.jobId, success, docsWritten, docsSkipped, docsRemoved, errors, durationMs: Date.now() - start };
    } catch (err: any) {
      errors.push({ stableId: job.jobId, message: err.message ?? String(err) });
      await this.stateRepo.markJobCompleted(job.jobId, false, {
        failureSummary: err.message ?? "Unknown error"
      });
      return { jobId: job.jobId, success: false, docsWritten, docsSkipped, docsRemoved, errors, durationMs: Date.now() - start };
    }
  }

  // ── Incremental ─────────────────────────────────────────────────

  private async runIncremental(
    job: { readonly affectedRecordIds: readonly string[] },
    errors: ExportExecutionError[]
  ): Promise<PlanExecutionResult> {
    const state = await this.stateRepo.load();
    const records = await this.dataSource.getRecordsByIds(job.affectedRecordIds);
    const previousRecords = job.affectedRecordIds
      .map((recordId) => state.records[recordId])
      .filter((record): record is ExporterRecordStateSnapshot => Boolean(record));
    const plan = planIncrementalExport(records, previousRecords);
    return this.executePlan(plan, records, errors, state);
  }

  // ── Scoped rebuild ─────────────────────────────────────────────

  private async runScopedRebuild(
    job: { readonly views: readonly ProjectionView[] },
    errors: ExportExecutionError[]
  ): Promise<PlanExecutionResult> {
    const allRecords = await this.dataSource.getAllRecords();
    const plan = planScopedRebuild(allRecords, job.views);
    return this.executePlanRebuild(plan, allRecords, errors);
  }

  // ── Full rebuild ───────────────────────────────────────────────

  private async runFullRebuild(
    job: { readonly views?: readonly ProjectionView[] },
    errors: ExportExecutionError[]
  ): Promise<PlanExecutionResult> {
    const allRecords = await this.dataSource.getAllRecords();
    const plan = planFullRebuild(allRecords, job.views);
    const result = await this.executePlanRebuild(plan, allRecords, errors);
    // Reconcile: remove stale files not in the plan
    await this.reconcileStaleFiles(plan);
    return result;
  }

  // ── Execute plan (incremental) ─────────────────────────────────

  private async executePlan(
    plan: AffectedProjectionDoc[],
    _allRecords: ProjectionRecord[],
    errors: ExportExecutionError[],
    previousState?: ExporterStateFile
  ): Promise<PlanExecutionResult> {
    let docsWritten = 0;
    let docsSkipped = 0;
    let docsRemoved = 0;

    const recordMap = new Map(_allRecords.map((r) => [r.recordId, r]));

    for (const doc of plan) {
      try {
        if (doc.remove) {
          await this.removeDoc(doc, previousState);
          docsRemoved++;
          continue;
        }

        if (doc.kind === ProjectionDocumentKind.Index) {
          const viewRecords = await this.dataSource.getRecordsForView(doc.view);
          const written = await this.writeIndexDoc(doc, viewRecords);
          written ? docsWritten++ : docsSkipped++;
          continue;
        }

        const record = recordMap.get(doc.recordId);
        if (!record) continue;

        const written = await this.writeRecordDoc(doc, record);
        written ? docsWritten++ : docsSkipped++;
      } catch (err: any) {
        errors.push({ stableId: doc.stableId, message: err.message ?? String(err) });
      }
    }

    return { docsWritten, docsSkipped, docsRemoved };
  }

  // ── Execute plan (rebuild) ─────────────────────────────────────

  private async executePlanRebuild(
    plan: { readonly docs: readonly AffectedProjectionDoc[] },
    _allRecords: ProjectionRecord[],
    errors: ExportExecutionError[]
  ): Promise<PlanExecutionResult> {
    let docsWritten = 0;
    let docsSkipped = 0;
    const recordMap = new Map(_allRecords.map((r) => [r.recordId, r]));

    for (const doc of plan.docs) {
      try {
        if (doc.kind === ProjectionDocumentKind.Index) {
          const viewRecords = await this.dataSource.getRecordsForView(doc.view);
          const written = await this.writeIndexDoc(doc, viewRecords);
          written ? docsWritten++ : docsSkipped++;
          continue;
        }

        const record = recordMap.get(doc.recordId);
        if (!record) continue;

        const written = await this.writeRecordDoc(doc, record);
        written ? docsWritten++ : docsSkipped++;
      } catch (err: any) {
        errors.push({ stableId: doc.stableId, message: err.message ?? String(err) });
      }
    }

    return { docsWritten, docsSkipped, docsRemoved: 0 };
  }

  // ── Write helpers ──────────────────────────────────────────────

  private async writeRecordDoc(
    doc: AffectedProjectionDoc,
    record: ProjectionRecord
  ): Promise<boolean> {
    const template = templateForView(doc.view, record);
    const markdown = renderMarkdownDocument({
      frontmatter: template.frontmatter,
      title: template.title,
      sections: template.sections
    });

    const resolved = resolveProjectionPath({
      rootDir: this.rootDir,
      view: doc.view,
      stableId: doc.stableId,
      kind: doc.kind,
      slug: template.slug
    });

    const result = await writeDocumentIfChanged(resolved.filePath, markdown);
    return result.changed;
  }

  private async writeIndexDoc(
    doc: AffectedProjectionDoc,
    viewRecords: ProjectionRecord[]
  ): Promise<boolean> {
    const content = renderIndexPage(doc.view, viewRecords);
    const resolved = resolveProjectionPath({
      rootDir: this.rootDir,
      view: doc.view,
      stableId: doc.stableId,
      kind: ProjectionDocumentKind.Index
    });

    const result = await writeDocumentIfChanged(resolved.filePath, content);
    return result.changed;
  }

  private async removeDoc(doc: AffectedProjectionDoc, previousState?: ExporterStateFile): Promise<void> {
    const previousPath = previousState?.records[doc.recordId]?.pathsByView[doc.view];
    if (previousPath) {
      const filePath = path.isAbsolute(previousPath) ? previousPath : path.join(this.rootDir, previousPath);
      await fs.unlink(filePath).catch(() => undefined);
      return;
    }

    const resolved = resolveProjectionPath({
      rootDir: this.rootDir,
      view: doc.view,
      stableId: doc.stableId,
      kind: doc.kind
    });
    await fs.unlink(resolved.filePath).catch(() => undefined);
  }

  private async buildCompletionStatePatch(job: ProjectionJob): Promise<ProjectionStatePatch> {
    const current = await this.stateRepo.load();
    if (job.type === ProjectionJobType.IncrementalExport) {
      const updatedRecords = { ...current.records };
      const currentRecords = await this.dataSource.getRecordsByIds(job.affectedRecordIds);
      for (const recordId of job.affectedRecordIds) {
        delete updatedRecords[recordId];
      }
      for (const record of currentRecords) {
        updatedRecords[record.recordId] = this.buildRecordState(record);
      }
      return this.buildStatePatchFromRecords(updatedRecords);
    }

    const allRecords = await this.dataSource.getAllRecords();
    const rebuiltRecords: Record<string, ExporterRecordStateSnapshot> = {};
    for (const record of allRecords) {
      rebuiltRecords[record.recordId] = this.buildRecordState(record);
    }

    if (job.type === ProjectionJobType.FullRebuild && !job.views) {
      return this.buildStatePatchFromRecords(rebuiltRecords);
    }

    const targetViews = job.type === ProjectionJobType.ScopedRebuild ? job.views : (job.views ?? Object.values(ProjectionView));
    const mergedRecords: Record<string, ExporterRecordStateSnapshot> = { ...current.records };
    for (const record of allRecords) {
      const previous = mergedRecords[record.recordId];
      const next = rebuiltRecords[record.recordId];
      const preservedViews = (previous?.views ?? []).filter((view) => !targetViews.includes(view));
      const targetRecordViews = next.views.filter((view) => targetViews.includes(view));
      const views = [...new Set([...preservedViews, ...targetRecordViews])];
      const pathsByView = { ...(previous?.pathsByView ?? {}) };
      for (const view of targetViews) {
        delete pathsByView[view];
      }
      for (const view of targetRecordViews) {
        pathsByView[view] = next.pathsByView[view];
      }
      if (views.length > 0) {
        mergedRecords[record.recordId] = { recordId: record.recordId, views, pathsByView };
      } else {
        delete mergedRecords[record.recordId];
      }
    }
    return this.buildStatePatchFromRecords(mergedRecords);
  }

  private buildRecordState(record: ProjectionRecord): ExporterRecordStateSnapshot {
    const views = classifyRecordToViews(record);
    const pathsByView: Partial<Record<ProjectionView, string>> = {};
    for (const view of views) {
      const template = templateForView(view, record);
      const stableId = buildStableProjectionId({
        view,
        grain: ProjectionAggregationGrain.Record,
        keyParts: [record.recordId]
      });
      pathsByView[view] = resolveProjectionPath({
        rootDir: this.rootDir,
        view,
        stableId,
        kind: ProjectionDocumentKind.Record,
        slug: template.slug
      }).relativePath;
    }
    return { recordId: record.recordId, views, pathsByView };
  }

  private buildStatePatchFromRecords(
    records: Record<string, ExporterRecordStateSnapshot>
  ): ProjectionStatePatch {
    const generatedAt = new Date().toISOString();
    const views: Partial<Record<ProjectionView, ExporterViewStateSnapshot>> = {};
    for (const view of Object.values(ProjectionView)) {
      const recordIds: string[] = [];
      const stableIds: string[] = [];
      for (const record of Object.values(records)) {
        if (!record.views.includes(view)) continue;
        recordIds.push(record.recordId);
        stableIds.push(buildStableProjectionId({
          view,
          grain: ProjectionAggregationGrain.Record,
          keyParts: [record.recordId]
        }));
      }
      if (recordIds.length > 0) {
        views[view] = {
          lastProjectionAt: generatedAt,
          recordIds,
          stableIds
        };
      }
    }
    return { records, views };
  }

  /**
   * During full rebuild, remove stale files that are no longer in the plan.
   * Scans each target view directory and removes files not in the plan's stable IDs.
   */
  private async reconcileStaleFiles(plan: { readonly views: readonly ProjectionView[]; readonly docs: readonly AffectedProjectionDoc[] }): Promise<void> {
    const plannedPaths = new Set(plan.docs.map((d) => {
      const resolved = resolveProjectionPath({
        rootDir: this.rootDir,
        view: d.view,
        stableId: d.stableId,
        kind: d.kind
      });
      return resolved.filePath;
    }));

    for (const view of plan.views) {
      const viewDir = path.join(this.rootDir, PROJECTION_VIEW_DIRECTORIES[view]);
      let files: string[];
      try {
        files = await this.listFilesRecursive(viewDir);
      } catch {
        continue; // directory doesn't exist yet, nothing to clean
      }

      for (const filePath of files) {
        if (!plannedPaths.has(filePath) && filePath.endsWith(".md") && !filePath.endsWith("index.md")) {
          await fs.unlink(filePath).catch(() => undefined);
        }
      }
    }
  }

  private async listFilesRecursive(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await this.listFilesRecursive(full));
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
    return files;
  }
}
