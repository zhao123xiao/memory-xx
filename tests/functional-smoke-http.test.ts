import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { parseFunctionalHttpResult } from "../scripts/lib/functional-smoke-http";

test("functional smoke HTTP parser treats non-2xx responses as failures", () => {
  const forbidden = parseFunctionalHttpResult('{"error":"forbidden"}\nHTTP_CODE:403');

  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body, '{"error":"forbidden"}');
});

test("functional smoke HTTP parser accepts 2xx responses and preserves body", () => {
  const created = parseFunctionalHttpResult('{"write":{"memoryId":"mem-1"}}\nHTTP_CODE:201');

  assert.equal(created.ok, true);
  assert.equal(created.status, 201);
  assert.equal(created.body, '{"write":{"memoryId":"mem-1"}}');
});

test("M1 functional smoke writes an effective recallable memory and fails on missing projection or recall", async () => {
  const script = await readFile(path.join(process.cwd(), "scripts/functional-test-memory-xx.sh"), "utf8");

  assert.match(script, /'lifecycleStatus': 'approved'/u);
  assert.match(script, /'reviewState': 'not_required'/u);
  assert.match(script, /'dedupeKey': 'm1:' \+ '\$\{TEST_PREFIX\}'/u);
  assert.match(script, /真实性测试记录 \(\$\{TEST_PREFIX\}\)/u);
  assert.doesNotMatch(script, /'lifecycleStatus': 'candidate'[\s\S]*?'reviewState': 'pending'/u);
  assert.match(script, /"filter": \{"must": \[\{"key": "memory_id"/u);
  assert.doesNotMatch(script, /scroll_filter/u);
  assert.match(script, /payload_memory_id/u);
  assert.match(script, /Qdrant 命中 memory_id 不匹配/u);
  assert.match(script, /fail "\$label: Qdrant 未在 20s 内出现/u);
  assert.doesNotMatch(script, /warn "\$label: Qdrant 未在 20s 内出现/u);
  assert.match(script, /recall_has_mem/u);
  assert.match(script, /recall 未命中新写入 memory_id/u);
  assert.doesNotMatch(script, /import json,sys; print\(d\.get\('audit'/u);
  assert.match(script, /fail "\$label: recall hits=0"/u);
  assert.doesNotMatch(script, /warn "\$label: recall hits=0"/u);
  assert.match(script, /local status=0/u);
  assert.match(script, /return "\$status"/u);
});
