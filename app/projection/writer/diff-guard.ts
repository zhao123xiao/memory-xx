import { promises as fs } from "node:fs";

import { atomicWriteText, type AtomicWriteOptions } from "./atomic-write";

export interface DiffGuardWriteResult {
  readonly changed: boolean;
  readonly targetPath: string;
}

export function normalizeDiffableContent(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trimEnd()
    .concat("\n");
}

export function shouldRewrite(oldContent: string | null | undefined, newContent: string): boolean {
  if (oldContent === null || oldContent === undefined) {
    return true;
  }

  return normalizeDiffableContent(oldContent) !== normalizeDiffableContent(newContent);
}

export async function writeDocumentIfChanged(
  targetPath: string,
  content: string,
  options: AtomicWriteOptions = {}
): Promise<DiffGuardWriteResult> {
  const existing = await fs.readFile(targetPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  });

  if (!shouldRewrite(existing, content)) {
    return {
      changed: false,
      targetPath
    };
  }

  await atomicWriteText(targetPath, normalizeDiffableContent(content), options);
  return {
    changed: true,
    targetPath
  };
}
