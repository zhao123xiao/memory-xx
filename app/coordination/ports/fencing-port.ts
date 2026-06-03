import type { LockScope } from "../types";

export interface FencingTokenInput {
  readonly lockScope: LockScope;
  readonly resourceId: string;
}

export interface ValidateFencingTokenInput extends FencingTokenInput {
  readonly fencingToken: number;
}

export interface FencingPort {
  nextToken(input: FencingTokenInput): Promise<number>;
  isCurrentToken(input: ValidateFencingTokenInput): Promise<boolean>;
}
