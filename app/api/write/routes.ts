import { API_PREFIXES } from "../../shared/constants";
import type { CreateMemoryService } from "../../write/services/create-memory-service";
import {
  createMemoryHandler
} from "./handlers/create-memory-handler";
import type { MemoryXXHttpRequest, MemoryXXHttpResponse } from "../http";
import type { CreateMemoryCommand } from "../../shared/contracts/write";

export interface MemoryXXRoute<TBody = unknown, TResponse = unknown> {
  readonly method: "POST";
  readonly path: string;
  handle(request: MemoryXXHttpRequest<TBody>): Promise<MemoryXXHttpResponse<TResponse>>;
}

export function buildWriteRoutes(
  createMemoryService: CreateMemoryService
): readonly MemoryXXRoute<CreateMemoryCommand, Awaited<ReturnType<CreateMemoryService["execute"]>>>[] {
  return [
    {
      method: "POST",
      path: `${API_PREFIXES.write}/memories`,
      handle: createMemoryHandler(createMemoryService)
    }
  ];
}
