import { extractGraphHints } from "../../intelligence/graph-extraction";
import * as runtime from "../../server/runtime";
import { isPostgresTransactionContext, withWriteTransaction } from "../../db/tx/write-transaction";

export async function persistGraphEntityLinks(input: {
  readonly memoryId: string;
  readonly content: string;
}): Promise<void> {
  const db = runtime.writeDatabase;
  if (!db) return;
  const hints = extractGraphHints(input.content);
  if (hints.entity_names.length === 0) return;
  await withWriteTransaction(db, async (tx) => {
    if (!isPostgresTransactionContext(tx)) return;
    for (const name of hints.entity_names) {
      const rows = await tx.query<{ id: string }>(
        `
          INSERT INTO memory_entities (entity_type, name, canonical_name, metadata)
          VALUES ('memory_hint', $1, lower($1), $2::jsonb)
          ON CONFLICT DO NOTHING
          RETURNING id
        `,
        [name, JSON.stringify({ source: "smart_write_graph_extraction", version: "deterministic-v1" })]
      );
      const entityId = rows[0]?.id ?? (await tx.query<{ id: string }>(
        `SELECT id FROM memory_entities WHERE lower(coalesce(canonical_name, name)) = lower($1) ORDER BY created_at ASC LIMIT 1`,
        [name]
      ))[0]?.id;
      if (!entityId) continue;
      await tx.query(
        `
          INSERT INTO memory_entity_links (entity_id, memory_id, role, confidence)
          SELECT $1::uuid, $2, 'mentioned', 0.74
          WHERE NOT EXISTS (
            SELECT 1 FROM memory_entity_links WHERE entity_id = $1::uuid AND memory_id = $2
          )
        `,
        [entityId, input.memoryId]
      );
    }
  });
}
