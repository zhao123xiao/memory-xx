import assert from "node:assert/strict";
import test from "node:test";

import { classifyQdrantCollection, inferLegacyMemoryType } from "../app/governance/maintenance-classifiers";

test("legacy memory type inference classifies common Chinese memory categories", () => {
  assert.deepEqual(inferLegacyMemoryType({
    content: "我以后写报告偏好先给结论，再给证据。",
    metadata: {},
  }), {
    memory_type: "preference",
    confidence: 0.84,
    reason: "preference_keywords",
  });

  assert.equal(inferLegacyMemoryType({
    content: "已经决定默认采用 unified recall 作为用户主路径。",
    metadata: {},
  }).memory_type, "decision");

  assert.equal(inferLegacyMemoryType({
    content: "生产写入必须带明确 scope，不能落到默认全局范围。",
    metadata: {},
  }).memory_type, "constraint");
});

test("legacy memory type inference falls back conservatively", () => {
  assert.equal(inferLegacyMemoryType({
    content: "memory-xx 当前主服务运行在本机。",
    metadata: {},
  }).memory_type, "fact");

  assert.equal(inferLegacyMemoryType({
    content: "短句",
    metadata: {},
  }).memory_type, "legacy_unknown");
});

test("qdrant collection classification separates active, knowledge, legacy, and unknown", () => {
  const base = {
    activeCollections: ["memory-xx-local-qwen8b-int4-v1"],
    knowledgeCollections: ["knowledge-v1"],
    referencedCollections: ["memory-xx-next"],
  };

  assert.deepEqual(classifyQdrantCollection({ ...base, name: "memory-xx-local-qwen8b-int4-v1" }), {
    role: "active",
    reason: "matches_active_collection_or_alias",
  });
  assert.deepEqual(classifyQdrantCollection({ ...base, name: "knowledge-v1" }), {
    role: "knowledge",
    reason: "matches_knowledge_collection",
  });
  assert.equal(classifyQdrantCollection({ ...base, name: "memory-xx-next" }).role, "archive_candidate");
  assert.equal(classifyQdrantCollection({ ...base, name: "openclaw_mem0_4096" }).role, "archive_candidate");
  assert.equal(classifyQdrantCollection({ ...base, name: "unlabeled-experiment" }).role, "unknown");
});
