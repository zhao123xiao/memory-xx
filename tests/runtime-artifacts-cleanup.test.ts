import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cleanupRuntimeArtifacts,
  scanRuntimeArtifacts
} from "../app/ops/runtime-artifacts-cleanup";

test("scanRuntimeArtifacts finds projector tmp files and env backups", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-xx-artifacts-"));
  await writeFile(path.join(root, "qdrant-projector-worker.status.json.123.tmp"), "tmp", "utf8");
  await writeFile(path.join(root, ".env.bak-example"), "env", "utf8");
  await writeFile(path.join(root, "keep.txt"), "keep", "utf8");

  const scan = await scanRuntimeArtifacts({ rootDir: root });

  assert.equal(scan.root_dir, root);
  assert.deepEqual(scan.files.map((file) => file.kind).sort(), ["env_backup", "projector_status_tmp"]);
  assert.equal(scan.files.some((file) => file.path.endsWith("keep.txt")), false);
});

test("cleanupRuntimeArtifacts dry-run does not mutate files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-xx-artifacts-"));
  await writeFile(path.join(root, "qdrant-projector-worker.status.json.123.tmp"), "tmp", "utf8");

  const result = await cleanupRuntimeArtifacts({ rootDir: root, apply: false });
  const entries = await readdir(root);

  assert.equal(result.apply, false);
  assert.equal(result.deleted.length, 0);
  assert.equal(entries.includes("qdrant-projector-worker.status.json.123.tmp"), true);
});

test("cleanupRuntimeArtifacts apply deletes tmp files and archives env backups", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-xx-artifacts-"));
  const archiveDir = path.join(root, ".runtime", "env-backups");
  await writeFile(path.join(root, "qdrant-projector-worker.status.json.123.tmp"), "tmp", "utf8");
  await writeFile(path.join(root, ".env.bak-example"), "env", "utf8");

  const result = await cleanupRuntimeArtifacts({ rootDir: root, archiveDir, apply: true });
  const entries = await readdir(root);
  const archived = await readFile(path.join(archiveDir, ".env.bak-example"), "utf8");

  assert.equal(result.apply, true);
  assert.equal(result.deleted.length, 1);
  assert.equal(result.archived.length, 1);
  assert.equal(entries.includes("qdrant-projector-worker.status.json.123.tmp"), false);
  assert.equal(entries.includes(".env.bak-example"), false);
  assert.equal(archived, "env");
});
