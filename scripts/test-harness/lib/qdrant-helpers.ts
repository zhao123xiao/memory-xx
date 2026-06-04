import { config } from "../config.js";

export async function getCollectionInfo(): Promise<{
  status: string;
  pointsCount: number;
  indexedVectorsCount: number;
  vectorSize: number;
}> {
  const resp = await fetch(`${config.qdrantUrl}/collections/${config.qdrantCollection}`);
  const data = await resp.json() as any;
  const result = data.result;
  return {
    status: result?.status ?? "unknown",
    pointsCount: result?.points_count ?? 0,
    indexedVectorsCount: result?.indexed_vectors_count ?? 0,
    vectorSize: result?.config?.params?.vectors?.size ?? 0,
  };
}

export async function scrollPoints(
  filter: Record<string, unknown>,
  limit = 10,
): Promise<Array<Record<string, unknown>>> {
  const resp = await fetch(
    `${config.qdrantUrl}/collections/${config.qdrantCollection}/points/scroll`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit, filter }),
      signal: AbortSignal.timeout(10000),
    },
  );
  const data = await resp.json() as any;
  return data.result?.points ?? [];
}

export async function scrollByMemoryId(
  memoryId: string,
): Promise<Array<Record<string, unknown>>> {
  return scrollPoints({
    must: [{ key: "memory_id", match: { value: memoryId } }],
  }, 1);
}

export async function scrollRandom(limit = 5): Promise<Array<Record<string, unknown>>> {
  const resp = await fetch(
    `${config.qdrantUrl}/collections/${config.qdrantCollection}/points/scroll`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit, with_payload: true }),
      signal: AbortSignal.timeout(10000),
    },
  );
  const data = await resp.json() as any;
  return data.result?.points ?? [];
}
