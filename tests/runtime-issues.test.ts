import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHealthRuntimeIssues,
  deriveMemoryServiceStatus,
} from "../app/ops/runtime-issues";

test("core health does not block when optional embedding manifest is not configured", () => {
  const issues = buildHealthRuntimeIssues({
    runtimeInitialised: true,
    vectorAvailable: true,
    generationOk: false,
    providerMatchesActiveGeneration: null,
    embeddingManifestRequired: false,
    tokenSeparationOk: true,
    configValidationOk: true,
    checkedAt: "2026-06-05T00:00:00.000Z",
  });

  assert.deepEqual(issues.map((issue) => issue.id), []);
  assert.equal(deriveMemoryServiceStatus({ baseOk: true, issues }), "ok");
});

test("health blocks on embedding generation mismatch when manifest governance is required", () => {
  const issues = buildHealthRuntimeIssues({
    runtimeInitialised: true,
    vectorAvailable: true,
    generationOk: false,
    providerMatchesActiveGeneration: null,
    embeddingManifestRequired: true,
    tokenSeparationOk: true,
    configValidationOk: true,
    checkedAt: "2026-06-05T00:00:00.000Z",
  });

  assert.deepEqual(issues.map((issue) => issue.id), ["embedding_generation_mismatch"]);
  assert.equal(deriveMemoryServiceStatus({ baseOk: false, issues }), "blocked");
});
