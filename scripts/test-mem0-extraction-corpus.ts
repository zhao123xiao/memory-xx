#!/usr/bin/env tsx
import "./test-harness/config.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { IntelligenceService } from "../app/intelligence/service";
import type { SmartExtractionResponse } from "../app/intelligence/types";

interface CorpusCase {
  readonly id: string;
  readonly text: string;
  readonly expected: {
    readonly should_write: boolean;
    readonly operation?: string;
    readonly memory_type?: string;
    readonly scope_type: string;
    readonly scope_id: string;
  };
}

function fixturePath(): string {
  return process.env.MEMORY_V2_MEM0_CORPUS_PATH?.trim() ||
    path.join(process.cwd(), "scripts/test-harness/fixtures/mem0-extraction-corpus.jsonl");
}

async function loadCorpus(): Promise<CorpusCase[]> {
  const raw = await readFile(fixturePath(), "utf8");
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CorpusCase);
}

function firstMemory(response: SmartExtractionResponse) {
  return response.memories[0] ?? null;
}

function includesCanonical(response: SmartExtractionResponse, term: string): boolean {
  const haystack = response.memories.map((memory) => memory.canonical_content).join("\n").toLowerCase();
  return haystack.includes(term.toLowerCase());
}

async function main(): Promise<void> {
  const corpus = await loadCorpus();
  const service = new IntelligenceService();
  const requireOfficialSuccess = process.env.MEMORY_V2_MEM0_REQUIRE_OFFICIAL_SUCCESS === "1";
  const results = [];
  let failed = 0;
  for (const item of corpus) {
    const response = await service.extract({
      text: item.text,
      agent_id: "mem0-corpus-gate",
      scope_hint: {
        scope_type: item.expected.scope_type,
        scope_id: item.expected.scope_id,
      },
      mode: "draft",
    });
    const memory = firstMemory(response);
    const checks = {
      should_write: response.should_write === item.expected.should_write,
      operation: !item.expected.operation || response.operation === item.expected.operation || memory?.operation === item.expected.operation,
      memory_type: !item.expected.memory_type || memory?.memory_type === item.expected.memory_type,
      scope: !memory || (memory.scope_type === item.expected.scope_type && memory.scope_id === item.expected.scope_id),
      no_test_token_leak: !includesCanonical(response, "abc123"),
      official_success: !requireOfficialSuccess || !response.should_write || response.mem0_official_success === true,
    };
    const ok = Object.values(checks).every(Boolean);
    if (!ok) failed += 1;
    results.push({
      id: item.id,
      ok,
      checks,
      expected: item.expected,
      actual: {
        ok: response.ok,
        should_write: response.should_write,
        operation: response.operation,
        provider: response.provider,
        mem0_used: response.mem0_used,
        mem0_mode: response.mem0_mode,
        mem0_attempted: response.mem0_attempted,
        mem0_success: response.mem0_success,
        mem0_attempted_mode: response.mem0_attempted_mode,
        mem0_official_attempted: response.mem0_official_attempted,
        mem0_official_success: response.mem0_official_success,
        mem0_fallback_reason: response.mem0_fallback_reason,
        fallback_used: response.fallback_used,
        fallback_reason: response.fallback_reason,
        failure_reason: response.failure_reason,
        memory: memory ? {
          memory_type: memory.memory_type,
          operation: memory.operation,
          scope_type: memory.scope_type,
          scope_id: memory.scope_id,
          canonical_content: memory.canonical_content,
        } : null,
      },
    });
  }
  const report = {
    ok: failed === 0,
    total: corpus.length,
    failed,
    results,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
