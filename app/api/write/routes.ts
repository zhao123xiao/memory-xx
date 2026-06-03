import { API_PREFIXES } from "../../shared/constants";
import type { CreateMemoryService } from "../../write/services/create-memory-service";
import {
  createMemoryHandler
} from "./handlers/create-memory-handler";
import type { MemoryV2HttpRequest, MemoryV2HttpResponse } from "../http";
import type { CreateMemoryCommand } from "../../shared/contracts/write";

export interface MemoryV2Route<TBody = unknown, TResponse = unknown> {
  readonly method: "POST";
  readonly path: string;
  handle(request: MemoryV2HttpRequest<TBody>): Promise<MemoryV2HttpResponse<TResponse>>;
}

export function buildWriteRoutes(
  createMemoryService: CreateMemoryService
): readonly MemoryV2Route<CreateMemoryCommand, Awaited<ReturnType<CreateMemoryService["execute"]>>>[] {
  return [
    {
      method: "POST",
      path: `${API_PREFIXES.write}/memories`,
      handle: createMemoryHandler(createMemoryService)
    }
  ];
}
