import type {
  CoordinationFinalStatus,
  CoordinationLease,
  CoordinationTaskRecord
} from "../types";

export interface RenewLeaseInput {
  readonly taskId: string;
  readonly leaseId: string;
  readonly ownerId: string;
  readonly ttlMs: number;
  readonly now: number;
}

export interface ReleaseLeaseInput {
  readonly taskId: string;
  readonly leaseId: string;
  readonly ownerId: string;
  readonly finalStatus: CoordinationFinalStatus;
  readonly now: number;
}

export interface LeasePort {
  renew(input: RenewLeaseInput): Promise<CoordinationLease>;
  releaseLease(input: ReleaseLeaseInput): Promise<CoordinationTaskRecord>;
}
