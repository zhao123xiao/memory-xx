import type { ArchiveMemoryCommand } from "../../../review/commands/archive-memory-command";
import type { ApproveMemoryCommand } from "../../../review/commands/approve-memory-command";
import type { RejectMemoryCommand } from "../../../review/commands/reject-memory-command";
import type { SupersedeMemoryCommand } from "../../../review/commands/supersede-memory-command";
import type { TombstoneMemoryCommand } from "../../../review/commands/tombstone-memory-command";
import type { ArchiveMemoryService } from "../../../review/services/archive-memory-service";
import type { ReviewDecisionService } from "../../../review/services/review-decision-service";
import type { SupersedeMemoryService } from "../../../review/services/supersede-memory-service";
import type { TombstoneMemoryService } from "../../../review/services/tombstone-memory-service";
import type {
  MemoryXXHttpRequest,
  MemoryXXHttpResponse
} from "../../http";

export function approveMemoryHandler(service: ReviewDecisionService) {
  return async (
    request: MemoryXXHttpRequest<ApproveMemoryCommand>
  ): Promise<MemoryXXHttpResponse<Awaited<ReturnType<ReviewDecisionService["approve"]>>>> => {
    const result = await service.approve(request.body);
    return {
      status: 200,
      body: result
    };
  };
}

export function rejectMemoryHandler(service: ReviewDecisionService) {
  return async (
    request: MemoryXXHttpRequest<RejectMemoryCommand>
  ): Promise<MemoryXXHttpResponse<Awaited<ReturnType<ReviewDecisionService["reject"]>>>> => {
    const result = await service.reject(request.body);
    return {
      status: 200,
      body: result
    };
  };
}

export function archiveMemoryHandler(service: ArchiveMemoryService) {
  return async (
    request: MemoryXXHttpRequest<ArchiveMemoryCommand>
  ): Promise<MemoryXXHttpResponse<Awaited<ReturnType<ArchiveMemoryService["execute"]>>>> => {
    const result = await service.execute(request.body);
    return {
      status: 200,
      body: result
    };
  };
}

export function supersedeMemoryHandler(service: SupersedeMemoryService) {
  return async (
    request: MemoryXXHttpRequest<SupersedeMemoryCommand>
  ): Promise<MemoryXXHttpResponse<Awaited<ReturnType<SupersedeMemoryService["execute"]>>>> => {
    const result = await service.execute(request.body);
    return {
      status: result.replayed ? 200 : 201,
      body: result
    };
  };
}

export function tombstoneMemoryHandler(service: TombstoneMemoryService) {
  return async (
    request: MemoryXXHttpRequest<TombstoneMemoryCommand>
  ): Promise<MemoryXXHttpResponse<Awaited<ReturnType<TombstoneMemoryService["execute"]>>>> => {
    const result = await service.execute(request.body);
    return {
      status: 200,
      body: result
    };
  };
}
