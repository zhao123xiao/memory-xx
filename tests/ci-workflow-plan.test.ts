import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("package exposes individual scripts for the plan-selected L0 L1 L2 L4 and L5 harness layers", () => {
  const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  for (const script of ["test:gates", "test:unit-contract", "test:integration", "test:quality", "test:prod-e2e"]) {
    assert.ok(pkg.scripts?.[script], script);
  }
});

test("package exposes the plan-specified test:layers entrypoint", () => {
  const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  assert.equal(pkg.scripts?.["test:layers"], "node --import tsx scripts/test-harness/reports/aggregator.ts");
});

test("CI invokes selected L0 L1 L2 L4 and L5 layers through the aggregate runner", () => {
  const source = readFileSync(path.join(process.cwd(), ".github/workflows/ci.yml"), "utf8");

  assert.match(source, /npm run test:layers -- --layer L0,L1,L2,L4,L5/u);
});

test("CI runs memory-v2 parity audit before runtime-dependent gates", () => {
  const source = readFileSync(path.join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
  const parityIndex = source.indexOf("npm run memory:parity-audit -- --fail-on-missing");
  const migrateIndex = source.indexOf("npm run migrate");
  const l5Index = source.indexOf("npm run test:layers -- --layer L0,L1,L2,L4,L5");

  assert.notEqual(parityIndex, -1, "parity audit step exists");
  assert.notEqual(migrateIndex, -1, "migration step exists");
  assert.notEqual(l5Index, -1, "L5 step exists");
  assert.ok(parityIndex < migrateIndex, "parity audit runs before migrations");
  assert.ok(parityIndex < l5Index, "parity audit runs before L5 runtime gates");
});

test("CI starts production E2E dependencies before the L5 harness", () => {
  const source = readFileSync(path.join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
  const l5Index = source.indexOf("npm run test:layers -- --layer L0,L1,L2,L4,L5");
  assert.notEqual(l5Index, -1, "L5 step exists");
  const beforeL5 = source.slice(0, l5Index);

  assert.match(source, /qdrant\/qdrant/u, "qdrant service is configured");
  assert.match(beforeL5, /npm run migrate/u, "database migrations run before L5");
  assert.match(beforeL5, /npm run start/u, "wrapper starts before L5");
  assert.match(beforeL5, /npm run run:qdrant-projector-worker/u, "projector worker starts before L5");
  assert.match(beforeL5, /\/health/u, "wrapper health is polled before L5");
});

test("CI provides harness configuration for selected layer tests", () => {
  const source = readFileSync(path.join(process.cwd(), ".github/workflows/ci.yml"), "utf8");

  for (const key of [
    "MEMORY_XX_API_TOKEN: ci-test-token",
    "MEMORY_XX_ADMIN_TOKEN: ci-test-token",
    "MEMORY_XX_QDRANT_BASE_URL: http://localhost:6333",
    "MEMORY_XX_QDRANT_COLLECTION: memory-xx-ci",
  ]) {
    assert.match(source, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), key);
  }
});
