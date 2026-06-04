import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LifecycleStatus,
  ReviewState,
  ScopeType,
  buildStableProjectionId,
  createGovernanceTemplate,
  createInitialProjectionJobState,
  hashStableProjectionId,
  isProjectionJob,
  mapProjectionVisibility,
  ProjectionAggregationGrain,
  ProjectionAudience,
  type ProjectionJob,
  ProjectionJobType,
  ProjectionView,
  renderMarkdownDocument,
  resolveProjectionPath,
  serializeFrontmatter,
  sortProjectionItems,
  writeDocumentIfChanged,
  atomicWriteText
} from "../app";

test("stable projection id stays deterministic across repeated builds", () => {
  const stableId = buildStableProjectionId({
    view: ProjectionView.Daily,
    grain: ProjectionAggregationGrain.Date,
    keyParts: ["2026-04-12"]
  });

  assert.equal(stableId, "daily:date:2026-04-12");
  assert.equal(hashStableProjectionId(stableId).length, 8);
  assert.equal(
    buildStableProjectionId({
      view: ProjectionView.Daily,
      grain: ProjectionAggregationGrain.Date,
      keyParts: ["2026-04-12"]
    }),
    stableId
  );
});

test("path resolver yields stable sanitized paths", () => {
  const first = resolveProjectionPath({
    rootDir: "/tmp/projection-test",
    view: ProjectionView.Projects,
    stableId: "projects:project:alpha-launch",
    slug: "Alpha / Launch",
    bucketSegments: ["Team A", "Sprint #1"]
  });

  const second = resolveProjectionPath({
    rootDir: "/tmp/projection-test",
    view: ProjectionView.Projects,
    stableId: "projects:project:alpha-launch",
    slug: "Alpha / Launch",
    bucketSegments: ["Team A", "Sprint #1"]
  });

  assert.equal(first.relativePath, second.relativePath);
  assert.equal(
    first.relativePath,
    `projects/team-a/sprint-1/alpha-launch--${hashStableProjectionId("projects:project:alpha-launch")}.md`
  );
});

test("frontmatter serializer keeps canonical key order", () => {
  const frontmatter = serializeFrontmatter({
    tags: ["alpha", "beta"],
    title: "Projection Title",
    projection_id: "projects:record:mem-1",
    exporter_version: "phase-b3-foundation",
    view: "projects",
    generated_at: "2026-04-12T00:00:00.000Z",
    scope: "project"
  });

  const lines = frontmatter.split("\n");
  assert.deepEqual(lines.slice(0, 7), [
    "---",
    "projection_id: projects:record:mem-1",
    "view: projects",
    "title: 'Projection Title'",
    "scope: project",
    "generated_at: 2026-04-12T00:00:00.000Z",
    "exporter_version: phase-b3-foundation"
  ]);
});

test("diff guard skips rewriting identical markdown content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memory-xx-projection-"));
  const targetPath = path.join(root, "projects", "alpha.md");
  const content = renderMarkdownDocument({
    frontmatter: {
      projection_id: "projects:record:mem-1",
      view: "projects",
      title: "Alpha"
    },
    title: "Alpha",
    summary: "Stable summary"
  });

  try {
    const first = await writeDocumentIfChanged(targetPath, content);
    assert.equal(first.changed, true);

    const before = await stat(targetPath);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await writeDocumentIfChanged(targetPath, content.replace(/\n/g, "\r\n"));
    const after = await stat(targetPath);

    assert.equal(second.changed, false);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomic write preserves previous content and cleans temp file on rename failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memory-xx-projection-"));
  const targetPath = path.join(root, "governance", "status.md");
  const tempPath = `${targetPath}.rename-failure`;

  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, "old-content\n", "utf8");

    await assert.rejects(
      atomicWriteText(targetPath, "new-content\n", {
        tempFileSuffix: "rename-failure",
        onBeforeRename: () => {
          throw new Error("rename blocked");
        }
      }),
      /rename blocked/
    );

    assert.equal(await readFile(targetPath, "utf8"), "old-content\n");
    await assert.rejects(stat(tempPath), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("visibility mapping keeps governance internal and out of shared navigation", () => {
  const decision = mapProjectionVisibility({
    recordId: "mem-1",
    scope: ScopeType.Project,
    lifecycleStatus: LifecycleStatus.Candidate,
    reviewState: ReviewState.Pending,
    isCurrent: true,
    title: "Pending memory",
    candidateViews: [ProjectionView.Projects, ProjectionView.Governance]
  });

  assert.deepEqual(decision.visibleViews, [ProjectionView.Governance]);
  assert.deepEqual(decision.sharedNavigationViews, []);
  assert.equal(decision.audienceByView[ProjectionView.Governance], ProjectionAudience.Internal);
});

test("stable sort uses stable id as final deterministic tiebreaker", () => {
  const sorted = sortProjectionItems(ProjectionView.Todos, [
    {
      stableId: "todos:record:b",
      dueDate: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
      statePriority: 1
    },
    {
      stableId: "todos:record:a",
      dueDate: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
      statePriority: 1
    }
  ]);

  assert.deepEqual(
    sorted.map((item) => item.stableId),
    ["todos:record:a", "todos:record:b"]
  );
});

test("template skeleton renders governance markdown smoke output", () => {
  const document = createGovernanceTemplate({
    recordId: "mem-99",
    scope: ScopeType.User,
    lifecycleStatus: LifecycleStatus.Rejected,
    reviewState: ReviewState.Rejected,
    isCurrent: false,
    title: "Governance Queue Entry",
    body: "Needs manual review.",
    updatedAt: "2026-04-12T00:00:00.000Z"
  });

  const markdown = renderMarkdownDocument({
    frontmatter: document.frontmatter,
    title: document.title,
    sections: document.sections
  });

  assert.equal(document.visibility, ProjectionAudience.Internal);
  assert.match(markdown, /# Governance Queue Entry/);
  assert.match(markdown, /## Governance/);
});

test("job guards accept frozen job model", () => {
  const job: ProjectionJob = {
    jobId: "job-1",
    type: ProjectionJobType.IncrementalExport,
    requestedAt: "2026-04-12T00:00:00.000Z",
    triggeredBy: "test",
    affectedRecordIds: ["mem-1"]
  };

  assert.equal(isProjectionJob(job), true);
  assert.deepEqual(createInitialProjectionJobState(job), {
    jobId: "job-1",
    type: ProjectionJobType.IncrementalExport,
    status: "pending",
    requestedAt: "2026-04-12T00:00:00.000Z",
    attempts: 0
  });
});
