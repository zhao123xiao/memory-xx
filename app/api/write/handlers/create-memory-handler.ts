import type { CreateMemoryCommand } from "../../../shared/contracts/write";
import type { CreateMemoryService } from "../../../write/services/create-memory-service";
import type {
  MemoryXXHttpRequest,
  MemoryXXHttpResponse
} from "../../http";

export function createMemoryHandler(service: CreateMemoryService) {
  return async (
    request: MemoryXXHttpRequest<CreateMemoryCommand>
  ): Promise<MemoryXXHttpResponse<Awaited<ReturnType<CreateMemoryService["execute"]>>>> => {
    const result = await service.execute(request.body);
    return {
      status: result.replayed ? 200 : 201,
      body: result
    };
  };
}
