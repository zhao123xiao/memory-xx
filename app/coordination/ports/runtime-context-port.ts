import type { RunRuntimeContext, TaskRuntimeContext } from "../types";

export interface RuntimeContextPort {
  putRunContext(context: RunRuntimeContext): Promise<RunRuntimeContext>;
  getRunContext(runId: string, now: number): Promise<RunRuntimeContext | null>;
  putTaskContext(context: TaskRuntimeContext): Promise<TaskRuntimeContext>;
  getTaskContext(taskId: string, now: number): Promise<TaskRuntimeContext | null>;
  purgeExpired(now: number): Promise<{ runsPurged: number; tasksPurged: number }>;
}
