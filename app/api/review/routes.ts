import { API_PREFIXES } from "../../shared/constants";
import type { ArchiveMemoryService } from "../../review/services/archive-memory-service";
import type { ReviewDecisionService } from "../../review/services/review-decision-service";
import type { SupersedeMemoryService } from "../../review/services/supersede-memory-service";
import type { TombstoneMemoryService } from "../../review/services/tombstone-memory-service";
import type { MemoryXXHttpRequest, MemoryXXHttpResponse } from "../http";
import {
  approveMemoryHandler,
  archiveMemoryHandler,
  rejectMemoryHandler,
  supersedeMemoryHandler,
  tombstoneMemoryHandler
} from "./handlers/review-memory-handlers";

export interface ReviewRoute<TBody = unknown, TResponse = unknown> {
  readonly method: "POST";
  readonly path: string;
  handle(request: MemoryXXHttpRequest<TBody>): Promise<MemoryXXHttpResponse<TResponse>>;
}

export function buildReviewRoutes(
  reviewDecisionService: ReviewDecisionService,
  archiveMemoryService: ArchiveMemoryService,
  supersedeMemoryService: SupersedeMemoryService,
  tombstoneMemoryService: TombstoneMemoryService
): readonly ReviewRoute[] {
  return [
    {
      method: "POST",
      path: `${API_PREFIXES.review}/memories/:memoryId/approve`,
      handle: approveMemoryHandler(reviewDecisionService)
    },
    {
      method: "POST",
      path: `${API_PREFIXES.review}/memories/:memoryId/reject`,
      handle: rejectMemoryHandler(reviewDecisionService)
    },
    {
      method: "POST",
      path: `${API_PREFIXES.review}/memories/:memoryId/archive`,
      handle: archiveMemoryHandler(archiveMemoryService)
    },
    {
      method: "POST",
      path: `${API_PREFIXES.review}/memories/:memoryId/supersede`,
      handle: supersedeMemoryHandler(supersedeMemoryService)
    },
    {
      method: "POST",
      path: `${API_PREFIXES.review}/memories/:memoryId/tombstone`,
      handle: tombstoneMemoryHandler(tombstoneMemoryService)
    }
  ];
}
