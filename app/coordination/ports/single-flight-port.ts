import type { SingleFlightClaimResult } from "../types";

export interface ClaimSingleFlightInput {
  readonly key: string;
  readonly ownerId: string;
  readonly taskId?: string;
  readonly ttlMs: number;
  readonly now: number;
}

export interface SingleFlightPort {
  claim(input: ClaimSingleFlightInput): Promise<SingleFlightClaimResult>;
  releaseFlight(key: string, ownerId: string): Promise<boolean>;
  sweepFlights(now: number): Promise<number>;
}
