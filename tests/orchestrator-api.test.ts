import assert from "node:assert/strict";
import test from "node:test";

import {
  ArchiveMemoryService,
  CreateMemoryService,
  IngestRequestStatus,
  InMemoryWriteDatabase,
  LifecycleStatus,
  MemoryOrchestratorService,
  ReviewState,
  ScopeType,
  TombstoneMemoryService,
  Visibility,
  isInMemoryTransactionContext,
  type CreateMemoryCommand,
  type RecallRequest,
  type RecallResponse,
  type RecallScopeRef,
  WriteCommandType,
} from "../app";

function createCommand(requestId: string, overrides: Partial<CreateMemoryCommand> = {}): CreateMemoryCommand {
  return {
    requestId,
    actorId: "tester",
    scopeType: ScopeType.Workspace,
    scopeId: "workspace-alpha",
    content: "Remember the alpha migration plan and cutover constraints.",
    title: "Alpha migration",
    summary: "Alpha migration constraints",
    lifecycleStatus: LifecycleStatus.Approved,
    reviewState: ReviewState.NotRequired,
    sources: [],
    relations: [],
    ...overrides,
  };
}

function createRecallRequest(): RecallRequest {
  return {
    query: "alpha migration plan",
    scope_context: {
      workspace_id: "workspace-alpha",
      user_id: "user-1",
      include_global: false,
    },
    limit: 5,
    offset: 0,
  };
}

function createMainRecallRequest(): RecallRequest {
  return {
    query: "main route plan",
    scope_context: {
      workspace_id: "workspace-main",
      user_id: "user-main",
      include_global: false,
      runtime: {
        run_id: "run-main",
      },
    },
    limit: 5,
    offset: 0,
  };
}

function createKleeRecallRequest(): RecallRequest {
  return {
    query: "klee route plan",
    scope_context: {
      workspace_id: "workspace-klee",
      user_id: "user-klee",
      include_global: false,
    },
    limit: 5,
    offset: 0,
  };
}

class FakeRecallOrchestrator {
  async execute(request: RecallRequest): Promise<RecallResponse> {
    const allowedScopeSet: RecallScopeRef[] = [
      { type: ScopeType.Workspace, id: request.scope_context.workspace_id ?? "workspace-alpha" },
      { type: ScopeType.User, id: request.scope_context.user_id ?? "user-1" },
    ];
    return {
      results: [
        {
          memory_id: "memory_record_00000000-0000-4000-8000-000000000001",
          title: "Alpha migration",
          content: "Remember the alpha migration plan and cutover constraints.",
          scope: { type: ScopeType.Workspace, id: "workspace-alpha" },
          score: 0.92,
          source_retrievers: ["lexical"],
          matched_terms: ["alpha", "migration"],
        },
      ],
      filter_mode_applied: "default",
      allowed_scope_set: allowedScopeSet,
      degraded: false,
      audit_ref: "audit:test:alpha",
      audit: {
        audit_ref: "audit:test:alpha",
        query_type: "project_context",
        strategy: "lexical_only",
        degraded: false,
        degrade_reasons: [],
        lexical_status: { name: "lexical", available: true },
        vector_status: { name: "vector", available: false, reason: "disabled in test" },
        lexical_hits: 1,
        vector_hits: 0,
        merged_hits: 1,
        returned_hits: 1,
      },
    } as RecallResponse;
  }
}

test("resolve_scope_plan prefers memory scope snapshot for main and klee style plans via shared helper reuse", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T02:00:00.000Z");
  const service = new MemoryOrchestratorService({
    recallOrchestrator: new FakeRecallOrchestrator() as never,
    createMemoryService: new CreateMemoryService({ database }),
    archiveMemoryService: new ArchiveMemoryService({ database }),
    tombstoneMemoryService: new TombstoneMemoryService({ database }),
    database,
    now: () => "2026-04-16T02:00:00.000Z",
  });

  const mainPlan = await service.resolve_scope_plan({
    recall_request: createMainRecallRequest(),
    memory_scope_snapshot: {
      memoryScope: {
        recallScopes: ["shared", "personal", "execution", "research", "governance"],
      },
      recallScopeContext: createMainRecallRequest().scope_context,
      route: {
        workspaceId: "workspace-main",
        userId: "user-main",
        projectId: "workspace-main",
        globalScopeId: "global",
        runtimeRunId: "run-main",
      },
    },
  });
  assert.deepEqual(mainPlan.allowedVisibilities, [
    Visibility.Shared,
    Visibility.Personal,
    Visibility.Research,
    Visibility.Governance,
    Visibility.Execution,
  ]);

  const kleePlan = await service.resolve_scope_plan({
    recall_request: createKleeRecallRequest(),
    memory_scope_snapshot: {
      memoryScope: {
        recallScopes: ["shared", "personal"],
      },
      recallScopeContext: createKleeRecallRequest().scope_context,
      route: {
        workspaceId: "workspace-klee",
        userId: "user-klee",
        projectId: "workspace-klee",
        globalScopeId: "global",
      },
    },
  });
  assert.deepEqual(kleePlan.allowedVisibilities, [Visibility.Shared, Visibility.Personal]);

  const orderedPlan = await service.resolve_scope_plan({
    recall_request: createKleeRecallRequest(),
    memory_scope_snapshot: {
      memoryScope: {
        recallScopes: ["execution", "shared", "shared"],
      },
      recallScopeContext: createKleeRecallRequest().scope_context,
      route: {
        workspaceId: "workspace-klee",
        userId: "user-klee",
        projectId: "workspace-klee",
        globalScopeId: "global",
      },
    },
  });
  assert.deepEqual(orderedPlan.allowedVisibilities, [Visibility.Shared, Visibility.Execution]);
});


test("resolve_scope_plan falls back to recall scope context when memory scope snapshot is unavailable", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T02:00:00.000Z");
  const service = new MemoryOrchestratorService({
    recallOrchestrator: new FakeRecallOrchestrator() as never,
    createMemoryService: new CreateMemoryService({ database }),
    archiveMemoryService: new ArchiveMemoryService({ database }),
    tombstoneMemoryService: new TombstoneMemoryService({ database }),
    database,
    now: () => "2026-04-16T02:00:00.000Z",
  });

  const plan = await service.resolve_scope_plan({
    recall_request: createMainRecallRequest(),
  });

  assert.deepEqual(plan.allowedVisibilities, [
    Visibility.Shared,
    Visibility.Personal,
    Visibility.Execution,
  ]);
});

test("memory orchestrator exposes minimal formal handlers", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T02:00:00.000Z");
  const createMemoryService = new CreateMemoryService({ database });
  const service = new MemoryOrchestratorService({
    recallOrchestrator: new FakeRecallOrchestrator() as never,
    createMemoryService,
    archiveMemoryService: new ArchiveMemoryService({ database }),
    tombstoneMemoryService: new TombstoneMemoryService({ database }),
    database,
    now: () => "2026-04-16T02:00:00.000Z",
  });

  const plan = await service.resolve_scope_plan({
    recall_request: createRecallRequest(),
  });
  assert.equal(plan.suggested_write_scope?.scopeType, ScopeType.Workspace);
  assert.equal(plan.suggested_write_scope?.scopeId, "workspace-alpha");
  assert.deepEqual(plan.allowedVisibilities, [Visibility.Shared, Visibility.Personal]);

  const write = await service.write_memory({
    command: createCommand("req-orch-write"),
  });
  assert.match(write.write.memoryId, /^memory_record_[0-9a-f-]{36}$/u);

  const recall = await service.recall_memory({ request: createRecallRequest() });
  assert.equal(recall.recall.results.length, 1);

  const summary = await service.summarize_memory({
    request: createRecallRequest(),
    max_items: 1,
  });
  assert.match(summary.summary.text, /Found 1 relevant memories/);
  assert.deepEqual(summary.summary.memory_ids, [write.write.memoryId]);

  const counts = await service.memory_counts({
    scopeType: ScopeType.Workspace,
    scopeId: "workspace-alpha",
    includeByScope: true,
  });
  assert.equal(counts.ok, true);
  assert.equal(counts.counts.total, 1);
  assert.equal(counts.counts.current, 1);
  assert.equal(counts.counts.approved_current, 1);
  assert.ok((counts.by_scope ?? []).some((row) => row.scopeId === "workspace-alpha"));

  const forget = await service.forget_memory({
    requestId: "req-orch-forget",
    actorId: "tester",
    memoryId: write.write.memoryId,
    mode: "tombstone",
  });
  assert.equal(forget.mode, "tombstone");
  assert.equal(forget.write.lifecycleStatus, LifecycleStatus.Tombstone);

  const audit = await service.audit_memory_consistency({ include_records: true });
  assert.equal(audit.checked_at, "2026-04-16T02:00:00.000Z");
  assert.equal(audit.counts.memory_records, 1);
  assert.ok(audit.snapshot);
});

test("audit_memory_consistency accepts replayed ingest request when result references existing outbox event", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T02:00:00.000Z");
  const service = new MemoryOrchestratorService({
    recallOrchestrator: new FakeRecallOrchestrator() as never,
    createMemoryService: new CreateMemoryService({ database }),
    archiveMemoryService: new ArchiveMemoryService({ database }),
    tombstoneMemoryService: new TombstoneMemoryService({ database }),
    database,
    now: () => "2026-04-16T02:00:00.000Z",
  });

  const write = await service.write_memory({
    command: createCommand("req-original"),
  });

  await database.withTransaction((tx) => {
    if (!isInMemoryTransactionContext(tx)) return;
    const ingest = tx.state.ingestRequests.find((row) => row.requestId === "req-original");
    if (!ingest) return;
    tx.state.ingestRequests.push({
      ...ingest,
      requestId: "req-replayed",
      result: {
        ...ingest.result,
        requestId: "req-replayed",
        memoryId: write.write.memoryId,
        outboxEventId: write.write.outboxEventId,
      },
    });
  });

  const audit = await service.audit_memory_consistency();
  assert.equal(audit.findings.some((finding) => finding.code === "missing_outbox_for_request"), false);
});

test("audit_memory_consistency accepts completed requests that intentionally skip outbox events", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T02:00:00.000Z");
  const service = new MemoryOrchestratorService({
    recallOrchestrator: new FakeRecallOrchestrator() as never,
    createMemoryService: new CreateMemoryService({ database }),
    archiveMemoryService: new ArchiveMemoryService({ database }),
    tombstoneMemoryService: new TombstoneMemoryService({ database }),
    database,
    now: () => "2026-04-16T02:00:00.000Z",
  });

  await database.withTransaction((tx) => {
    if (!isInMemoryTransactionContext(tx)) return;
    tx.state.ingestRequests.push({
      requestId: "req-outbox-skipped",
      commandType: WriteCommandType.RecallFeedback,
      payloadHash: "hash-outbox-skipped",
      payloadJson: "{}",
      actorId: "tester",
      status: IngestRequestStatus.Completed,
      firstSeenAt: "2026-04-16T02:00:00.000Z",
      lastSeenAt: "2026-04-16T02:00:00.000Z",
      completedAt: "2026-04-16T02:00:00.000Z",
      result: {
        requestId: "req-outbox-skipped",
        commandType: "recall.feedback",
        outbox_events_skipped: true,
      },
      errorCode: null,
      errorMessage: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      recoverableAfter: null,
      recoverable: true,
    });
  });

  const audit = await service.audit_memory_consistency();
  assert.equal(audit.ok, true);
  assert.equal(audit.findings.some((finding) => finding.code === "missing_outbox_for_request"), false);
});

test("repair_memory_consistency detects and reports issues in dry-run mode", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T02:00:00.000Z");
  const service = new MemoryOrchestratorService({
    recallOrchestrator: new FakeRecallOrchestrator() as never,
    createMemoryService: new CreateMemoryService({ database }),
    archiveMemoryService: new ArchiveMemoryService({ database }),
    tombstoneMemoryService: new TombstoneMemoryService({ database }),
    database,
    now: () => "2026-04-16T02:00:00.000Z",
  });

  const write = await service.write_memory({
    command: createCommand("req-repair-dry"),
  });
  const memoryId = write.write.memoryId;

  await database.withTransaction((tx) => {
    if (!isInMemoryTransactionContext(tx)) return;
    const idx = tx.state.memoryRecords.findIndex((r) => r.id === memoryId);
    if (idx !== -1) {
      tx.state.memoryRecords[idx] = { ...tx.state.memoryRecords[idx], isCurrent: false };
    }
  });

  const result = await service.repair_memory_consistency({ dry_run: true });
  assert.equal(result.dry_run, true);
  assert.equal(result.repairs.length, 1);
  assert.equal(result.repairs[0].code, "non_current_approved_record");
  assert.equal(result.repairs[0].memoryId, memoryId);
  assert.equal(result.repairs[0].action, "manual_review_required");

  const verify = await database.snapshot();
  const record = verify.memoryRecords.find((r) => r.id === memoryId);
  assert.equal(record?.isCurrent, false, "dry-run should not modify state");
});

test("repair_memory_consistency does not auto-reactivate approved non-current records", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T02:00:00.000Z");
  const service = new MemoryOrchestratorService({
    recallOrchestrator: new FakeRecallOrchestrator() as never,
    createMemoryService: new CreateMemoryService({ database }),
    archiveMemoryService: new ArchiveMemoryService({ database }),
    tombstoneMemoryService: new TombstoneMemoryService({ database }),
    database,
    now: () => "2026-04-16T02:00:00.000Z",
  });

  const write = await service.write_memory({
    command: createCommand("req-repair-apply"),
  });
  const memoryId = write.write.memoryId;

  await database.withTransaction((tx) => {
    if (!isInMemoryTransactionContext(tx)) return;
    const idx = tx.state.memoryRecords.findIndex((r) => r.id === memoryId);
    if (idx !== -1) {
      tx.state.memoryRecords[idx] = { ...tx.state.memoryRecords[idx], isCurrent: false };
    }
  });

  const result = await service.repair_memory_consistency({ dry_run: false });
  assert.equal(result.dry_run, false);
  assert.equal(result.repairs.length, 1);
  assert.equal(result.repairs[0].action, "manual_review_required");

  const verify = await database.snapshot();
  const record = verify.memoryRecords.find((r) => r.id === memoryId);
  assert.equal(record?.isCurrent, false, "repair should leave historical approved rows for manual review");
});

test("repair_memory_consistency applies duplicate-current fixes with lifecycle events and outbox", async () => {
  const database = new InMemoryWriteDatabase(() => "2026-04-16T02:00:00.000Z");
  const service = new MemoryOrchestratorService({
    recallOrchestrator: new FakeRecallOrchestrator() as never,
    createMemoryService: new CreateMemoryService({ database }),
    archiveMemoryService: new ArchiveMemoryService({ database }),
    tombstoneMemoryService: new TombstoneMemoryService({ database }),
    database,
    now: () => "2026-04-16T02:00:00.000Z",
  });

  const first = await service.write_memory({ command: createCommand("req-repair-dup-a", { content: "duplicate current content" }) });
  const second = await service.write_memory({ command: createCommand("req-repair-dup-b", { content: "temporary unique content" }) });
  await database.withTransaction((tx) => {
    if (!isInMemoryTransactionContext(tx)) return;
    const idx = tx.state.memoryRecords.findIndex((r) => r.id === second.write.memoryId);
    if (idx !== -1) {
      tx.state.memoryRecords[idx] = {
        ...tx.state.memoryRecords[idx],
        content: "duplicate current content",
        createdAt: "2026-04-16T02:00:01.000Z",
      };
    }
  });
  const before = await database.snapshot();

  const result = await service.repair_memory_consistency({ dry_run: false });
  assert.equal(result.repairs.some((repair) => repair.code === "multiple_current_records_per_scope" && repair.action === "set_is_current_false"), true);

  const after = await database.snapshot();
  const currentRows = after.memoryRecords.filter((row) => row.content === "duplicate current content" && row.isCurrent);
  assert.equal(currentRows.length, 1);
  assert.equal(after.memoryEvents.length, before.memoryEvents.length + 1);
  assert.equal(after.outboxEvents.length, before.outboxEvents.length + 1);
  assert.equal(after.cacheInvalidationRequests.length, before.cacheInvalidationRequests.length + 1);
  assert.equal(after.memoryEvents.at(-1)?.eventType, "memory.lifecycle.changed");
  assert.equal(after.outboxEvents.at(-1)?.eventType, "memory.lifecycle.changed");
  assert.equal(after.cacheInvalidationRequests.at(-1)?.reason, "multiple_current_records_per_scope");
  assert.ok([first.write.memoryId, second.write.memoryId].includes(currentRows[0].id));
});
