import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { classifyQdrantCollection } from "../app/governance/maintenance-classifiers";
import { loadMemoryXXQdrantConfig } from "../app/recall/qdrant-config";
import { requireCliPermission } from "../app/server/permissions";
import { loadDotenvIfPresent, printJson } from "./lib/runtime-env";

loadDotenvIfPresent();

type QdrantCollectionsResponse = {
  result?: { collections?: Array<{ name?: string }> };
};

type QdrantAliasesResponse = {
  result?: { aliases?: Array<{ alias_name?: string; collection_name?: string }> };
};

function readFileSafe(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

function collectReferencedCollections(): string[] {
  const systemdDir = `${process.env.HOME ?? ""}/.config/systemd/user`;
  const systemdFiles = existsSync(systemdDir)
    ? readdirSync(systemdDir)
      .filter((name) => name.endsWith(".service") || name.endsWith(".timer"))
      .map((name) => `${systemdDir}/${name}`)
    : [];
  const files = [
    ".env",
    ".env.fastpath",
    ...systemdFiles
  ];
  const refs = new Set<string>();
  const pattern = /\b(?:MEMORY_XX_QDRANT_COLLECTION|MEMORY_XX_QDRANT_ALIAS|QDRANT_COLLECTION|collection_name)\s*=?\s*["']?([A-Za-z0-9_.:-]+)/gu;
  for (const file of files) {
    const content = readFileSafe(file);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1]) refs.add(match[1]);
    }
  }
  return [...refs];
}

async function main(): Promise<void> {
  await requireCliPermission("memory:governance_read");
  const config = loadMemoryXXQdrantConfig();
  if (!config.base_url) throw new Error("MEMORY_XX_QDRANT_BASE_URL is required");
  const baseUrl = config.base_url.replace(/\/+$/u, "");
  const headers: Record<string, string> = {};
  if (config.api_key) headers["api-key"] = config.api_key;
  const response = await fetch(`${baseUrl}/collections`, { headers });
  if (!response.ok) throw new Error(`qdrant_collections_http_${response.status}`);
  const parsed = await response.json() as QdrantCollectionsResponse;
  const aliasResponse = await fetch(`${baseUrl}/aliases`, { headers });
  const aliases = aliasResponse.ok
    ? ((await aliasResponse.json()) as QdrantAliasesResponse).result?.aliases ?? []
    : [];
  const aliasTargets = aliases
    .filter((item): item is { alias_name: string; collection_name: string } => Boolean(item.alias_name && item.collection_name));
  const names = (parsed.result?.collections ?? []).map((item) => item.name).filter((name): name is string => Boolean(name));
  const active = [
    config.collection_name,
    process.env.MEMORY_XX_QDRANT_ALIAS?.trim(),
    process.env.MEMORY_XX_QDRANT_ACTIVE_COLLECTION?.trim(),
    ...aliasTargets
      .filter((alias) => alias.alias_name === config.collection_name || alias.alias_name === process.env.MEMORY_XX_QDRANT_ALIAS?.trim())
      .map((alias) => alias.collection_name)
  ].filter((name): name is string => Boolean(name));
  const knowledge = [
    process.env.MEMORY_XX_KNOWLEDGE_QDRANT_COLLECTION?.trim(),
    "knowledge-v1"
  ].filter((name): name is string => Boolean(name));
  const referenced = collectReferencedCollections();
  const collections = names.map((name) => ({
    name,
    ...classifyQdrantCollection({
      name,
      activeCollections: active,
      knowledgeCollections: knowledge,
      referencedCollections: referenced
    })
  }));
  printJson({
    ok: true,
    base_url: baseUrl,
    aliases: aliasTargets,
    active_collections: active,
    knowledge_collections: knowledge,
    referenced_collections: referenced,
    collections,
    counts: collections.reduce<Record<string, number>>((acc, item) => {
      acc[item.role] = (acc[item.role] ?? 0) + 1;
      return acc;
    }, {}),
    source_files_scanned: [".env", ".env.fastpath", `${basename(process.env.HOME ?? "~")}/.config/systemd/user/*.service`]
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
