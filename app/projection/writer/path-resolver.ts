import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  PROJECTION_INDEX_FILE_NAME,
  PROJECTION_MARKDOWN_EXTENSION,
  PROJECTION_ROOT_DIR,
  PROJECTION_VIEW_DIRECTORIES
} from "../constants";
import { ProjectionDocumentKind, type ProjectionPathInput, type ResolvedProjectionPath } from "../types";

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function sanitizePathSegment(value: string, fallback = "untitled"): string {
  const asciiOnly = collapseWhitespace(value)
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "");

  const slug = asciiOnly
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || fallback;
}

function buildStableFileSlug(stableId: string, slug?: string): string {
  const readablePart = sanitizePathSegment(slug ?? stableId.split(":").at(-1) ?? stableId);
  const stableHash = createHash("sha1").update(stableId).digest("hex").slice(0, 8);
  return `${readablePart.slice(0, 64)}--${stableHash}`;
}

export function resolveProjectionPath(input: ProjectionPathInput): ResolvedProjectionPath {
  const rootDir = input.rootDir ?? PROJECTION_ROOT_DIR;
  const kind = input.kind ?? ProjectionDocumentKind.Record;
  const directorySegments = input.bucketSegments?.map((segment) => sanitizePathSegment(segment, "bucket")) ?? [];
  const baseDirectory = PROJECTION_VIEW_DIRECTORIES[input.view];
  const directory = path.join(rootDir, baseDirectory, ...directorySegments);

  const extension = input.extension ?? PROJECTION_MARKDOWN_EXTENSION;
  const fileName =
    kind === ProjectionDocumentKind.Index
      ? PROJECTION_INDEX_FILE_NAME
      : `${buildStableFileSlug(input.stableId, input.slug)}${extension}`;

  const filePath = path.join(directory, fileName);

  return {
    rootDir,
    view: input.view,
    directory,
    fileName,
    filePath,
    relativePath: path.relative(rootDir, filePath),
    bucketSegments: directorySegments,
    slug: kind === ProjectionDocumentKind.Index ? "index" : fileName.slice(0, -extension.length)
  };
}

export async function ensureProjectionDirs(input: ProjectionPathInput | ResolvedProjectionPath): Promise<string> {
  const resolved = "filePath" in input ? input : resolveProjectionPath(input);
  await fs.mkdir(resolved.directory, { recursive: true });
  return resolved.directory;
}
