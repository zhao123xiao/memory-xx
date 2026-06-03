import { initRuntime, closeRuntime } from "./runtime";
import { startHttpServer } from "./http-server";
import { parseCliArgs, runRecall, runWrite } from "./cli";
import type { RecallCliArgs, WriteCliArgs } from "./types";

export async function runServer(): Promise<void> {
  await initRuntime();
  startHttpServer();
}

export async function runCli(argv: string[]): Promise<void> {
  const parsedArgs = parseCliArgs(argv);
  if (parsedArgs.action === "recall") {
    await runRecall(parsedArgs as RecallCliArgs);
  } else {
    await runWrite(parsedArgs as WriteCliArgs);
  }
}
