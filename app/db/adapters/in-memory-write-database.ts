import {
  cloneWriteDatabaseState,
  createEmptyWriteDatabaseState,
  type SequenceName,
  type WriteDatabaseState
} from "../schema/tables";
import {
  type InMemoryWriteTransactionContext as InMemoryTxContext,
  type WriteTransactionContext,
  type WriteTransactionRunner
} from "../tx/write-transaction";

export type InMemoryIdFactory = (sequenceName: SequenceName, nextValue: number) => string;

export interface InMemoryWriteDatabaseOptions {
  readonly idFactory?: InMemoryIdFactory;
}

class InMemoryWriteTransactionContext implements InMemoryTxContext {
  readonly backend = "memory" as const;
  readonly state: WriteDatabaseState;

  constructor(
    state: WriteDatabaseState,
    private readonly clock: () => string,
    private readonly idFactory: InMemoryIdFactory
  ) {
    this.state = state;
  }

  now(): string {
    return this.clock();
  }

  nextId(sequenceName: SequenceName): string {
    const nextValue = this.state.sequences[sequenceName] + 1;
    this.state.sequences[sequenceName] = nextValue;
    return this.idFactory(sequenceName, nextValue);
  }
}

export class InMemoryWriteDatabase implements WriteTransactionRunner {
  private state: WriteDatabaseState;

  constructor(
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly options: InMemoryWriteDatabaseOptions = {}
  ) {
    this.state = createEmptyWriteDatabaseState();
  }

  async withTransaction<TResult>(
    work: (tx: WriteTransactionContext) => TResult | Promise<TResult>
  ): Promise<TResult> {
    const draft = cloneWriteDatabaseState(this.state);
    const tx = new InMemoryWriteTransactionContext(draft, this.clock, this.options.idFactory ?? defaultInMemoryIdFactory);
    const result = await work(tx);
    this.state = draft;
    return result;
  }

  async snapshot(): Promise<WriteDatabaseState> {
    return cloneWriteDatabaseState(this.state);
  }

  async snapshotForMemoryIds(memoryIds: readonly string[]): Promise<WriteDatabaseState> {
    const idSet = new Set(memoryIds);
    const full = await this.snapshot();
    return {
      memoryRecords: full.memoryRecords.filter((r) => idSet.has(r.id)),
      memorySources: full.memorySources.filter((r) => idSet.has(r.memoryId)),
      memoryRelations: full.memoryRelations.filter((r) => idSet.has(r.memoryId)),
      memoryEvents: [],
      ingestRequests: [],
      outboxEvents: [],
      migrationAudit: [],
      exporterState: [],
      lowConfidenceBuffer: [],
      writeTickets: [],
      writeTicketsArchive: [],
      memoryFeedbackEvents: [],
      recallTraces: [],
      recallFeedbackEvents: [],
      recallRepairQueue: [],
      cacheInvalidationRequests: [],
      knowledgeScopeGrants: [],
      intelligenceCompareObservations: [],
      scopeGenerations: full.scopeGenerations.map((row) => ({ ...row })),
      trustedAgents: [],
      sequences: { ...full.sequences }
    };
  }
}

function defaultInMemoryIdFactory(sequenceName: SequenceName, nextValue: number): string {
  return `${sequenceName}_${counterUuidV4(nextValue)}`;
}

function counterUuidV4(nextValue: number): string {
  const suffix = Math.max(0, nextValue).toString(16).padStart(12, "0").slice(-12);
  return `00000000-0000-4000-8000-${suffix}`;
}
