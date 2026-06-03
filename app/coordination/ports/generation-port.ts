import type {
  CoordinationGenerationKey,
  CoordinationGenerationRecord
} from "../types";

export interface BumpGenerationInput {
  readonly key: CoordinationGenerationKey;
  readonly now: number;
  readonly reason: string;
  readonly sourceEventId?: string;
}

export interface GenerationPort {
  getGeneration(key: CoordinationGenerationKey): Promise<CoordinationGenerationRecord>;
  bump(input: BumpGenerationInput): Promise<CoordinationGenerationRecord>;
}
