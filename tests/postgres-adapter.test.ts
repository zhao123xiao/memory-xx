import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createHash, randomUUID } from "node:crypto";

import { Pool } from "pg";

import {
  ArchiveMemoryService,
  CreateMemoryService,
  IngestRequestRepository,
  IngestRequestStatus,
  createPostgresRecallRuntime,
  LifecycleStatus,
  PostgresWriteDatabase,
  QueryType,
  RecallFeedbackRepository,
  ReviewDecisionService,
  ReviewState,
  RetrievalStrategy,
  ScopeType,
  createPostgresPoolConfig,
  isEffectiveRecallable,
  loadMemoryXXPostgresConfig,
  runPostgresMigrations,
  withWriteTransaction,
  WriteCommandType
} from "../app";

test("loadMemoryXXPostgresConfig reads the minimal postgres env surface", () => {
  const config = loadMemoryXXPostgresConfig({
    MEMORY_XX_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/memory_xx",
    MEMORY_XX_DATABASE_SCHEMA: "memory_xx_test",
    MEMORY_XX_DATABASE_MAX_CONNECTIONS: "4",
    MEMORY_XX_DATABASE_IDLE_TIMEOUT_MS: "5000",
    MEMORY_XX_DATABASE_CONNECTION_TIMEOUT_MS: "3000",
    MEMORY_XX_DATABASE_SSLMODE: "disable"
  });

  assert.equal(config.databaseUrl, "postgres://postgres:postgres@127.0.0.1:5432/memory_xx");
  assert.equal(config.schema, "memory_xx_test");
  assert.equal(config.maxConnections, 4);
  assert.equal(config.idleTimeoutMs, 5000);
  assert.equal(config.connectionTimeoutMs, 3000);
  assert.equal(config.ssl, false);
});

test("snapshotForMemoryIds serializes queries on a single PostgreSQL client", async () => {
  const config = loadMemoryXXPostgresConfig({
    MEMORY_XX_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/memory_xx",
    MEMORY_XX_DATABASE_SCHEMA: "memory_xx_serial_snapshot"
  });
  let inFlight = 0;
  let maxInFlight = 0;
  const queryOrder: string[] = [];
  const client = {
    async query(sql: string) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      queryOrder.push(sql);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return { rows: [] };
    },
    release() {}
  };
  const pool = {
    async connect() {
      return client;
    }
  };
  const database = new PostgresWriteDatabase({ config, pool: pool as unknown as Pool });

  await database.snapshotForMemoryIds(["memory_record_serial_query_guard"]);

  assert.equal(maxInFlight, 1);
  assert.deepEqual(
    queryOrder.filter((sql) => sql.startsWith("SELECT * FROM memory_")),
    [
      "SELECT * FROM memory_records WHERE id IN ($1)",
      "SELECT * FROM memory_sources WHERE memory_id IN ($1)",
      "SELECT * FROM memory_relations WHERE memory_id IN ($1)",
      "SELECT * FROM memory_relations WHERE related_memory_id IN ($1)"
    ]
  );
});

test(
  "postgres adapter and migration runner persist review lifecycle writes on the PostgreSQL path",
  {
    skip: process.env.MEMORY_XX_DATABASE_URL
      ? undefined
      : "Set MEMORY_XX_DATABASE_URL to run the PostgreSQL integration path."
  },
  async () => {
    const schema = `memory_xx_test_${randomUUID().replace(/-/g, "_")}`;
    const config = loadMemoryXXPostgresConfig({
      ...process.env,
      MEMORY_XX_DATABASE_URL: process.env.MEMORY_XX_DATABASE_URL,
      MEMORY_XX_DATABASE_SCHEMA: schema
    });
    const database = new PostgresWriteDatabase({ config });
    const cleanupPool = new Pool(createPostgresPoolConfig(config));

    try {
      const migrationResult = await runPostgresMigrations({
        config,
        migrationsDirectory: path.resolve(process.cwd(), "migrations")
      });

      assert.equal(migrationResult.applied.some((migration) => migration.filename === "0001_initial.sql"), true);
      assert.equal(
        migrationResult.applied.some((migration) => migration.filename === "0002_review_lifecycle.sql"),
        true
      );

      const service = new CreateMemoryService({ database });
      const reviewDecisionService = new ReviewDecisionService({ database });
      const archiveMemoryService = new ArchiveMemoryService({ database });
      const created = await service.execute({
        requestId: "pg-create-1",
        actorId: "postgres-tester",
        scopeType: ScopeType.Project,
        scopeId: "project-alpha",
        content: "Review this candidate through PostgreSQL.",
        title: "Postgres candidate",
        summary: "Real lifecycle coverage",
        lifecycleStatus: LifecycleStatus.Candidate,
        reviewState: ReviewState.Pending,
        sources: [
          {
            sourceType: "doc",
            uri: "file://docs/memory-xx/operations/README.md",
            excerpt: "postgres verification"
          }
        ],
        relations: []
      });
      const approved = await reviewDecisionService.approve({
        requestId: "pg-approve-1",
        actorId: "postgres-tester",
        memoryId: created.memoryId
      });
      const archived = await archiveMemoryService.execute({
        requestId: "pg-archive-1",
        actorId: "postgres-tester",
        memoryId: created.memoryId
      });

      const snapshot = await database.snapshot();
      assert.equal(created.replayed, false);
      assert.equal(approved.replayed, false);
      assert.equal(archived.replayed, false);
      assert.equal(snapshot.memoryRecords.length, 1);
      assert.equal(snapshot.memoryRecords[0].lifecycleStatus, LifecycleStatus.Archived);
      assert.equal(isEffectiveRecallable(snapshot.memoryRecords[0]), false);
      assert.equal(snapshot.memorySources.length, 1);
      assert.equal(snapshot.memoryEvents.length, 3);
      assert.equal(snapshot.outboxEvents.length, 3);
      assert.equal(snapshot.ingestRequests.length, 3);
      assert.equal(snapshot.ingestRequests.every((request) => request.status === "completed"), true);
    } finally {
      await database.close();

      const client = await cleanupPool.connect();
      try {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        client.release();
        await cleanupPool.end();
      }
    }
  }
);

test(
  "postgres fresh schema records recall-feedback through idempotent command chain without memory outbox",
  {
    skip: process.env.MEMORY_XX_DATABASE_URL
      ? undefined
      : "Set MEMORY_XX_DATABASE_URL to run the PostgreSQL integration path."
  },
  async () => {
    const schema = `memory_xx_feedback_${randomUUID().replace(/-/g, "_")}`;
    const config = loadMemoryXXPostgresConfig({
      ...process.env,
      MEMORY_XX_DATABASE_URL: process.env.MEMORY_XX_DATABASE_URL,
      MEMORY_XX_DATABASE_SCHEMA: schema
    });
    const database = new PostgresWriteDatabase({ config });
    const cleanupPool = new Pool(createPostgresPoolConfig(config));

    try {
      await runPostgresMigrations({
        config,
        migrationsDirectory: path.resolve(process.cwd(), "migrations")
      });

      await withWriteTransaction(database, async (tx) => {
        const recallFeedback = new RecallFeedbackRepository();
        const ingestRequests = new IngestRequestRepository();
        await recallFeedback.addTrace(tx, {
          id: "pg-recall-feedback-trace",
          queryHash: "pg-recall-feedback-query",
          queryExcerpt: "fresh pg recall feedback",
          actorId: "postgres-feedback",
          scopeContext: { project_ids: ["pg-feedback-project"] },
          queryType: QueryType.ProjectContext,
          strategy: RetrievalStrategy.Hybrid,
          degradeLevel: 0,
          results: { memory_ids: ["pg-feedback-memory"] },
          audit: {}
        });
        const payloadJson = JSON.stringify({
          recall_trace_id: "pg-recall-feedback-trace",
          feedback_type: "false_null"
        });
        await ingestRequests.insertAccepted(tx, {
          requestId: "pg-recall-feedback-command",
          commandType: WriteCommandType.RecallFeedback,
          payloadHash: createHash("sha256").update(payloadJson).digest("hex"),
          payloadJson,
          actorId: "postgres-feedback"
        });
        const event = await recallFeedback.addFeedback(tx, {
          recallTraceId: "pg-recall-feedback-trace",
          memoryId: null,
          actorId: "postgres-feedback",
          feedbackType: "false_null",
          metadata: { source: "postgres_adapter_test" }
        });
        const repair = await recallFeedback.upsertRepairQueue(tx, {
          queryHash: "pg-recall-feedback-query",
          recallTraceId: "pg-recall-feedback-trace",
          issueType: "false_null",
          details: { source: "postgres_adapter_test" },
          rootCauseType: "embedding_gap",
          rootCause: "embedding_gap",
          suggestedAction: "repair_embedding"
        });
        await ingestRequests.markCompleted(tx, "pg-recall-feedback-command", {
          commandType: WriteCommandType.RecallFeedback,
          requestId: "pg-recall-feedback-command",
          recallTraceId: "pg-recall-feedback-trace",
          feedbackEventId: event.id,
          repairQueueId: repair.id,
          outboxEventsSkipped: true
        });
      });

      const snapshot = await database.snapshot();
      assert.equal(snapshot.ingestRequests.length, 1);
      assert.equal(snapshot.ingestRequests[0].commandType, WriteCommandType.RecallFeedback);
      assert.equal(snapshot.ingestRequests[0].status, IngestRequestStatus.Completed);
      assert.equal(snapshot.recallFeedbackEvents.length, 1);
      assert.equal(snapshot.recallRepairQueue.length, 1);
      assert.equal(snapshot.outboxEvents.length, 0);
    } finally {
      await database.close();

      const client = await cleanupPool.connect();
      try {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        client.release();
        await cleanupPool.end();
      }
    }
  }
);

test(
  "postgres recall path applies default filter, scope gate, metadata SQL filters, and hybrid degrade",
  {
    skip: process.env.MEMORY_XX_DATABASE_URL
      ? undefined
      : "Set MEMORY_XX_DATABASE_URL to run the PostgreSQL integration path."
  },
  async () => {
    const schema = `memory_xx_recall_${randomUUID().replace(/-/g, "_")}`;
    const config = loadMemoryXXPostgresConfig({
      ...process.env,
      MEMORY_XX_DATABASE_URL: process.env.MEMORY_XX_DATABASE_URL,
      MEMORY_XX_DATABASE_SCHEMA: schema
    });
    const database = new PostgresWriteDatabase({ config });
    const cleanupPool = new Pool(createPostgresPoolConfig(config));
    const runtime = createPostgresRecallRuntime({
      config,
      query_embedding_provider: {
        async embed_query() {
          return {
            embedding: [0.1, 0.2, 0.3],
            audit: {
              fresh_cache_hit: false,
              stale_cache_hit: false,
              attempt_count: 1
            }
          };
        }
      }
    });

    try {
      await runPostgresMigrations({
        config,
        migrationsDirectory: path.resolve(process.cwd(), "migrations")
      });

      const createMemoryService = new CreateMemoryService({ database });
      const archiveMemoryService = new ArchiveMemoryService({ database });
      const visible = await createMemoryService.execute({
        requestId: "pg-recall-visible",
        actorId: "postgres-recall",
        scopeType: ScopeType.Project,
        scopeId: "p-alpha",
        content: "Candidate-only draft mentions urgent markdown for alpha but remains pending review.",
        title: "Alpha markdown preference",
        summary: "Visible lexical hit",
        metadata: {
          project_id: "p-alpha",
          tags: ["urgent"],
          entity_names: ["Alice Smith"],
          lexical_terms: ["alice", "markdown", "alpha", "context"],
          semantic_terms: ["alpha", "launch", "context"]
        },
        lifecycleStatus: LifecycleStatus.Approved,
        reviewState: ReviewState.Approved,
        sources: [
          {
            sourceType: "md",
            uri: "memory/2026-04-12.md",
            excerpt: "alpha markdown preference"
          }
        ],
        relations: []
      });

      await createMemoryService.execute({
        requestId: "pg-recall-candidate",
        actorId: "postgres-recall",
        scopeType: ScopeType.Project,
        scopeId: "p-alpha",
        content: "Archived markdown fixture for alpha scope should not be recallable after archive.",
        title: "Candidate should stay hidden",
        summary: "Hidden by default filter",
        metadata: {
          project_id: "p-alpha",
          tags: ["urgent"],
          entity_names: ["Alice Smith"],
          lexical_terms: ["alice", "markdown", "alpha", "context"]
        },
        lifecycleStatus: LifecycleStatus.Candidate,
        reviewState: ReviewState.Pending,
        sources: [
          {
            sourceType: "md",
            uri: "memory/hidden-candidate.md"
          }
        ],
        relations: []
      });

      const archived = await createMemoryService.execute({
        requestId: "pg-recall-archived",
        actorId: "postgres-recall",
        scopeType: ScopeType.Project,
        scopeId: "p-alpha",
        content: "Alice keeps markdown notes about alpha launch context.",
        title: "Archived should stay hidden",
        summary: "Hidden by archive state",
        metadata: {
          project_id: "p-alpha",
          tags: ["urgent"],
          entity_names: ["Alice Smith"],
          lexical_terms: ["alice", "markdown", "alpha", "context"]
        },
        lifecycleStatus: LifecycleStatus.Approved,
        reviewState: ReviewState.Approved,
        sources: [
          {
            sourceType: "md",
            uri: "memory/hidden-archived.md"
          }
        ],
        relations: []
      });
      await archiveMemoryService.execute({
        requestId: "pg-recall-archive-command",
        actorId: "postgres-recall",
        memoryId: archived.memoryId
      });

      await createMemoryService.execute({
        requestId: "pg-recall-other-source",
        actorId: "postgres-recall",
        scopeType: ScopeType.Project,
        scopeId: "p-alpha",
        content: "Alpha schema migration notes live in SQL.",
        title: "SQL source record",
        summary: "Used for source metadata filter",
        metadata: {
          project_id: "p-alpha",
          tags: ["backend"],
          entity_names: ["Alice Smith"],
          lexical_terms: ["alpha", "schema", "sql"]
        },
        lifecycleStatus: LifecycleStatus.Approved,
        reviewState: ReviewState.Approved,
        sources: [
          {
            sourceType: "sql",
            uri: "migrations/0001_initial.sql"
          }
        ],
        relations: []
      });

      await createMemoryService.execute({
        requestId: "pg-recall-other-scope",
        actorId: "postgres-recall",
        scopeType: ScopeType.Project,
        scopeId: "p-beta",
        content: "Alice keeps markdown notes about alpha launch context.",
        title: "Other scope should stay hidden",
        summary: "Scope gate coverage",
        metadata: {
          project_id: "p-beta",
          tags: ["urgent"],
          entity_names: ["Alice Smith"],
          lexical_terms: ["alice", "markdown", "alpha", "context"]
        },
        lifecycleStatus: LifecycleStatus.Approved,
        reviewState: ReviewState.Approved,
        sources: [
          {
            sourceType: "md",
            uri: "memory/p-beta.md"
          }
        ],
        relations: []
      });

      const lexicalResponse = await runtime.orchestrator.execute({
        query: 'source:md project:p-alpha #urgent "Alice Smith" markdown alpha',
        scope_context: {
          project_ids: ["p-alpha"]
        },
        explain: true
      });

      if (lexicalResponse.degraded) {
        assert.match(
          lexicalResponse.degrade_reason ?? "",
          /(pgvector_extension_unavailable|vector_column_unavailable|vector_backend_unavailable)/
        );
      }
      assert.deepEqual(
        lexicalResponse.results.map((result) => result.memory_id),
        [visible.memoryId]
      );
      assert.equal(lexicalResponse.audit.lexical_hits, 1);
      assert.equal(lexicalResponse.audit.vector_hits, 0);
      assert.equal(lexicalResponse.explain?.retrieval.returned_hits, 1);

      const scopedOut = await runtime.orchestrator.execute({
        query: 'source:md project:p-alpha #urgent "Alice Smith" markdown alpha',
        scope_context: {
          project_ids: ["p-beta"]
        }
      });
      assert.equal(scopedOut.results.length, 0);

      const degradedHybrid = await runtime.orchestrator.execute({
        query: 'project:p-alpha "Alice Smith" urgent alpha context',
        scope_context: {
          project_ids: ["p-alpha"]
        },
        explain: true,
        debug: {
          include_strategy_plan: true
        }
      });
      assert.equal(degradedHybrid.degraded, true);
      assert.match(
        degradedHybrid.degrade_reason ?? "",
        /(pgvector_extension_unavailable|vector_column_unavailable|vector_backend_unavailable)/
      );
      assert.equal(
        degradedHybrid.results.some((result) => result.memory_id === visible.memoryId),
        true
      );
      assert.equal(degradedHybrid.audit.returned_hits >= 1, true);
      assert.equal(degradedHybrid.explain?.retrieval.rerank_applied, true);
      assert.equal(degradedHybrid.explain?.retrieval.merged_hits >= 1, true);

    } finally {
      await runtime.close();
      await database.close();

      const client = await cleanupPool.connect();
      try {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        client.release();
        await cleanupPool.end();
      }
    }
  }
);
