import type { CreateMemoryCommand } from "../../../shared/contracts/write";
import type { CreateMemoryService } from "../../../write/services/create-memory-service";
import type {
  MemoryV2HttpRequest,
  MemoryV2HttpResponse
} from "../../http";

export function createMemoryHandler(service: CreateMemoryService) {
  return async (
    request: MemoryV2HttpRequest<CreateMemoryCommand>
  ): Promise<MemoryV2HttpResponse<Awaited<ReturnType<CreateMemoryService["execute"]>>>> => {
    const result = await service.execute(request.body);
    return {
      status: result.replayed ? 200 : 201,
      body: result
    };
  };
}
