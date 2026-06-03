import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildKnowledgeMarkdownManifest,
  buildKnowledgeMarkdownRows,
  chunkMarkdownDocument,
  executeMarkdownArchivePlan,
  scanMarkdownFiles,
  type MarkdownClassification,
  type MarkdownGovernanceCurrentState,
} from "../app/knowledge/markdown-governance";

const currentState: MarkdownGovernanceCurrentState = {
  now: "2026-06-03T00:00:00.000Z",
  runtimeOk: true,
  candidateCurrent: 0,
  qdrantDrift: false,
  p1GatePass: true,
  productionGuardOk: true,
};

async function withTempDir<T>(callback: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-md-"));
  try {
    return await callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("scan excludes dependency markdown and returns project markdown candidates", async () => {
  await withTempDir(async (root) => {
    const reportPath = join(root, "docs", "memory-xx", "report.md");
    const dependencyPath = join(root, "node_modules", "pkg", "README.md");
    mkdirSync(join(root, "docs", "memory-xx"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(reportPath, "# Memory XX Report\n\nruntime_ok=true\n", { encoding: "utf8" });
    writeFileSync(dependencyPath, "# Dependency\n", { encoding: "utf8" });

    const files = await scanMarkdownFiles({ root });

    assert.equal(files.length, 1);
    assert.equal(files[0]?.path, reportPath);
    assert.equal(files[0]?.relative_path, "docs/memory-xx/report.md");
    assert.equal(files[0]?.content_hash.length, 64);
  });
});

test("manifest records lifecycle, archive path, and import metadata", () => {
  const classifications: MarkdownClassification[] = [
    {
      path: "/workspace/local/docs/current.md",
      relative_path: "docs/current.md",
      size_bytes: 42,
      modified_at: "2026-06-02T00:00:00.000Z",
      content_hash: "a".repeat(64),
      lifecycle: "import_current",
      doc_type: "runbook",
      collection: "project:memory-xx:docs",
      repo: "memory-xx",
      classification_reason: "current_runbook",
      verified_against_current_state: true,
    },
    {
      path: "/workspace/local/docs/old.md",
      relative_path: "docs/old.md",
      size_bytes: 42,
      modified_at: "2026-04-01T00:00:00.000Z",
      content_hash: "b".repeat(64),
      lifecycle: "archive_obsolete_no_import",
      doc_type: "status_register",
      collection: null,
      repo: "memory-xx",
      classification_reason: "closed_or_expired_status_register",
      verified_against_current_state: true,
    },
  ];

  const manifest = buildKnowledgeMarkdownManifest({
    runId: "knowledge-md-test",
    generatedAt: "2026-06-03T00:00:00.000Z",
    archiveRoot: "/workspace/local/.memory-xx-knowledge-archive",
    classifications,
  });

  assert.equal(manifest.summary.total, 2);
  assert.equal(manifest.summary.import_current, 1);
  assert.equal(manifest.summary.archive_obsolete_no_import, 1);
  assert.equal(manifest.entries[0]?.should_import, true);
  assert.equal(manifest.entries[0]?.archived_path, "/workspace/local/.memory-xx-knowledge-archive/knowledge-md-test/docs/current.md");
  assert.equal(manifest.entries[1]?.should_import, false);
});

test("markdown chunks preserve line ranges and knowledge rows only include import_current entries", () => {
  const content = [
    "# Memory XX Runbook",
    "",
    "## Runtime",
    "runtime_ok=true",
    "",
    "## Qdrant",
    "Qdrant drift must remain 0.",
  ].join("\n");
  const chunks = chunkMarkdownDocument({
    path: "/workspace/local/docs/runbook.md",
    content,
    maxChars: 80,
  });

  assert.ok(chunks.length >= 1);
  assert.equal(chunks[0]?.start_line, 1);
  assert.ok((chunks[0]?.end_line ?? 0) >= 3);

  const rows = buildKnowledgeMarkdownRows({
    entries: [
      {
        path: "/workspace/local/docs/runbook.md",
        relative_path: "docs/runbook.md",
        size_bytes: content.length,
        modified_at: "2026-06-02T00:00:00.000Z",
        content,
        content_hash: "c".repeat(64),
        lifecycle: "import_current",
        doc_type: "runbook",
        collection: "project:memory-xx:docs",
        repo: "memory-xx",
        classification_reason: "current_runbook",
        verified_against_current_state: true,
        archived_path: "/archive/docs/runbook.md",
        should_import: true,
        should_archive: true,
      },
      {
        path: "/workspace/local/docs/old.md",
        relative_path: "docs/old.md",
        size_bytes: 5,
        modified_at: "2026-04-01T00:00:00.000Z",
        content: "# Old",
        content_hash: "d".repeat(64),
        lifecycle: "archive_obsolete_no_import",
        doc_type: "status_register",
        collection: null,
        repo: "memory-xx",
        classification_reason: "closed_or_expired_status_register",
        verified_against_current_state: true,
        archived_path: "/archive/docs/old.md",
        should_import: false,
        should_archive: true,
      },
    ],
    ingestRunId: "knowledge-md-test",
  });

  assert.equal(rows.documents.length, 1);
  assert.equal(rows.documents[0]?.collection, "project:memory-xx:docs");
  assert.equal(rows.chunks.length, chunks.length);
  assert.equal(rows.chunks[0]?.metadata.doc_lifecycle, "import_current");
  assert.equal(rows.chunks[0]?.metadata.archived_path, "/archive/docs/runbook.md");
});

test("archive plan dry-run does not move files and apply preserves manifest mapping", async () => {
  await withTempDir(async (root) => {
    const source = join(root, "docs", "old.md");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(source, "# Old report\n", "utf8");
    const archiveRoot = join(root, "archive");
    const manifest = buildKnowledgeMarkdownManifest({
      runId: "knowledge-md-test",
      generatedAt: "2026-06-03T00:00:00.000Z",
      archiveRoot,
      classifications: [{
        path: source,
        relative_path: "docs/old.md",
        size_bytes: 13,
        modified_at: "2026-04-01T00:00:00.000Z",
        content_hash: "e".repeat(64),
        lifecycle: "archive_obsolete_no_import",
        doc_type: "status_register",
        collection: null,
        repo: "memory-xx",
        classification_reason: "closed_or_expired_status_register",
        verified_against_current_state: true,
      }],
    });

    const dryRun = await executeMarkdownArchivePlan({ manifest, apply: false });
    assert.equal(dryRun.moved.length, 0);
    assert.equal(dryRun.planned.length, 1);
    assert.equal(existsSync(source), true);

    const applied = await executeMarkdownArchivePlan({ manifest, apply: true });
    assert.equal(applied.moved.length, 1);
    assert.equal(existsSync(source), false);
    assert.equal(existsSync(manifest.entries[0]!.archived_path), true);
    assert.equal(readFileSync(manifest.entries[0]!.archived_path, "utf8"), "# Old report\n");
  });
});
