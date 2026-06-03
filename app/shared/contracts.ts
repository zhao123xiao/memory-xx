import { API_PREFIXES, DEFAULT_FILTER_MODE } from "./constants";
import { FilterMode } from "./types";

export interface RecallApiContract {
  readonly prefix: string;
  readonly defaultFilterMode: FilterMode.Default;
  readonly role: "single-long-term-read-entrypoint";
}

export interface WriteApiContract {
  readonly prefix: string;
  readonly role: "write-and-ingest-entrypoint";
}

export interface ReviewApiContract {
  readonly prefix: string;
  readonly role: "candidate-and-lifecycle-governance-entrypoint";
}

export interface ProjectionApiContract {
  readonly prefix: string;
  readonly role: "projection-control-and-status";
}

export interface OpsApiContract {
  readonly prefix: string;
  readonly role: "health-metrics-and-diagnostics";
}

export const RECALL_API_CONTRACT: RecallApiContract = {
  prefix: API_PREFIXES.recall,
  defaultFilterMode: DEFAULT_FILTER_MODE,
  role: "single-long-term-read-entrypoint"
};

export const WRITE_API_CONTRACT: WriteApiContract = {
  prefix: API_PREFIXES.write,
  role: "write-and-ingest-entrypoint"
};

export const REVIEW_API_CONTRACT: ReviewApiContract = {
  prefix: API_PREFIXES.review,
  role: "candidate-and-lifecycle-governance-entrypoint"
};

export const PROJECTION_API_CONTRACT: ProjectionApiContract = {
  prefix: API_PREFIXES.projection,
  role: "projection-control-and-status"
};

export const OPS_API_CONTRACT: OpsApiContract = {
  prefix: API_PREFIXES.ops,
  role: "health-metrics-and-diagnostics"
};
