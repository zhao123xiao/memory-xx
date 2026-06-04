import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { PROJECTION_TEMP_FILE_PREFIX } from "../constants";

export interface AtomicWriteOptions {
  readonly encoding?: BufferEncoding;
  readonly tempFileSuffix?: string;
  readonly onBeforeRename?: (tempPath: string, targetPath: string) => Promise<void> | void;
}

export interface AtomicWriteResult {
  readonly targetPath: string;
  readonly tempPath: string;
}

function buildTempPath(targetPath: string, tempFileSuffix?: string): string {
  const suffix =
    tempFileSuffix ?? `${PROJECTION_TEMP_FILE_PREFIX}-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;

  return `${targetPath}.${suffix}`;
}

export async function atomicWriteText(
  targetPath: string,
  content: string,
  options: AtomicWriteOptions = {}
): Promise<AtomicWriteResult> {
  const encoding = options.encoding ?? "utf8";
  const tempPath = buildTempPath(targetPath, options.tempFileSuffix);
  const directory = path.dirname(targetPath);

  await fs.mkdir(directory, { recursive: true });

  let handle: FileHandle | undefined;

  try {
    handle = await fs.open(tempPath, "w");
    await handle.writeFile(content, { encoding });
    await handle.sync();
    await handle.close();
    handle = undefined;

    await options.onBeforeRename?.(tempPath, targetPath);
    await fs.rename(tempPath, targetPath);

    return {
      targetPath,
      tempPath
    };
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }

    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
