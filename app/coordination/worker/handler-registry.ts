import type { CoordinationJobHandler } from "../jobs";

export class CoordinationHandlerRegistry {
  private readonly handlers = new Map<string, CoordinationJobHandler>();

  register(handler: CoordinationJobHandler): void {
    this.handlers.set(handler.taskType, handler);
  }

  get(taskType: string): CoordinationJobHandler | undefined {
    return this.handlers.get(taskType);
  }
}
