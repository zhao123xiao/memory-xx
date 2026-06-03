import "./test-harness/config";

const qdrantBase = process.env.MEMORY_V2_QDRANT_BASE_URL?.replace(/\/+$/, "") || "http://127.0.0.1:6333";
const qdrantApiKey = process.env.MEMORY_V2_QDRANT_API_KEY?.trim();

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg === name || arg.startsWith(prefix));
  if (!found) return undefined;
  if (found === name) return "true";
  return found.slice(prefix.length);
}

function headers(): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(qdrantApiKey ? { "api-key": qdrantApiKey } : {}),
  };
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status}:${text.slice(0, 500)}`);
  return body;
}

async function aliases(): Promise<Array<{ alias_name: string; collection_name: string }>> {
  const body = await fetchJson(`${qdrantBase}/aliases`, { headers: headers() });
  return Array.isArray(body?.result?.aliases) ? body.result.aliases : [];
}

async function switchAlias(aliasName: string, collectionName: string): Promise<void> {
  const current = (await aliases()).find((item) => item.alias_name === aliasName);
  const actions = [
    ...(current ? [{ delete_alias: { alias_name: aliasName } }] : []),
    { create_alias: { collection_name: collectionName, alias_name: aliasName } },
  ];
  await fetchJson(`${qdrantBase}/collections/aliases`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ actions }),
  });
}

async function deleteAlias(aliasName: string): Promise<void> {
  const current = (await aliases()).find((item) => item.alias_name === aliasName);
  if (!current) return;
  await fetchJson(`${qdrantBase}/collections/aliases`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ actions: [{ delete_alias: { alias_name: aliasName } }] }),
  });
}

async function main(): Promise<void> {
  const command = process.argv[2] || "status";
  const aliasName = argValue("--alias") || process.env.MEMORY_V2_QDRANT_ALIAS || "memory-xx-active";
  const collectionName = argValue("--collection");

  if (command === "status") {
    console.log(JSON.stringify({ ok: true, qdrant_base: qdrantBase, aliases: await aliases() }, null, 2));
    return;
  }
  if (command === "switch" || command === "create") {
    if (!collectionName) throw new Error("--collection is required");
    await switchAlias(aliasName, collectionName);
    console.log(JSON.stringify({ ok: true, alias: aliasName, target_collection: collectionName }, null, 2));
    return;
  }
  if (command === "delete") {
    await deleteAlias(aliasName);
    console.log(JSON.stringify({ ok: true, deleted_alias: aliasName }, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

