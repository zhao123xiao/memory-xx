import { config } from "../test-harness/config.js";
import { closePool, createPool, query } from "../test-harness/lib/db-helpers.js";
import { clampInt, safeText, tableName } from "./utils.js";

export interface PanelGraphNode {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly subtitle: string;
  readonly score: number;
  readonly metadata: Record<string, unknown>;
}

export interface PanelGraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly type: string;
  readonly label: string;
  readonly weight: number;
  readonly metadata?: Record<string, unknown>;
}

export interface PanelGraph {
  readonly summary: Record<string, unknown>;
  readonly nodes: readonly PanelGraphNode[];
  readonly edges: readonly PanelGraphEdge[];
}

interface GraphQueryOptions {
  readonly query: string;
  readonly limit: number;
  readonly edge_limit: number;
  readonly depth: number;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly focus_id: string;
}

const DEFAULT_GRAPH_NODE_LIMIT = 80;
const MAX_GRAPH_NODE_LIMIT = 220;
const MAX_GRAPH_EDGE_LIMIT = 420;

function table(name: string): string {
  return tableName(config.dbSchema, name);
}

function nodeLabel(value: unknown, fallback: string): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 77)}...` : text || fallback;
}

function pushNode(nodes: Map<string, PanelGraphNode>, node: PanelGraphNode): void {
  const existing = nodes.get(node.id);
  if (!existing || node.score > existing.score) nodes.set(node.id, node);
}

function pushEdge(edges: Map<string, PanelGraphEdge>, edge: PanelGraphEdge): void {
  if (edge.source === edge.target) return;
  if (!edges.has(edge.id)) edges.set(edge.id, edge);
}

function parseGraphQueryOptions(url: URL, defaults: { scopeType: string; scopeId: string }): GraphQueryOptions {
  const limit = clampInt(url.searchParams.get("limit"), DEFAULT_GRAPH_NODE_LIMIT, 1, MAX_GRAPH_NODE_LIMIT);
  return {
    query: safeText(url.searchParams.get("query"), 180),
    limit,
    edge_limit: Math.min(MAX_GRAPH_EDGE_LIMIT, Math.max(40, limit * 2)),
    depth: clampInt(url.searchParams.get("depth"), 1, 1, 2),
    scope_type: safeText(url.searchParams.get("scopeType"), 40) || defaults.scopeType,
    scope_id: safeText(url.searchParams.get("scopeId"), 140) || defaults.scopeId,
    focus_id: safeText(url.searchParams.get("focusId"), 220),
  };
}

function scopeFilter(alias: string, options: GraphQueryOptions, params: unknown[]): string {
  const clauses: string[] = [];
  if (options.scope_type) {
    params.push(options.scope_type);
    clauses.push(`${alias}.scope_type = $${params.length}`);
  }
  if (options.scope_id) {
    params.push(options.scope_id);
    clauses.push(`${alias}.scope_id = $${params.length}`);
  }
  return clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";
}

export async function buildGraphSummary(): Promise<Record<string, unknown>> {
  const pool = createPool();
  try {
    const overview = await query(pool, `
      SELECT
        (SELECT count(*)::int FROM ${table("memory_records")}) AS records,
        (SELECT count(*)::int FROM ${table("memory_records")} WHERE is_current IS TRUE AND lifecycle_status = 'approved') AS approved_current_records,
        (SELECT count(*)::int FROM ${table("memory_episodes")}) AS episodes,
        (SELECT count(*)::int FROM ${table("memory_entities")}) AS entities,
        (SELECT count(*)::int FROM ${table("memory_entity_links")}) AS entity_links,
        (SELECT count(*)::int FROM ${table("memory_relations")}) AS relations,
        (SELECT count(*)::int FROM ${table("memory_records")} mr
          WHERE mr.is_current IS TRUE AND mr.lifecycle_status = 'approved'
          AND NOT EXISTS (SELECT 1 FROM ${table("memory_entity_links")} mel WHERE mel.memory_id = mr.id)
        ) AS missing_entity_link,
        (SELECT count(*)::int FROM ${table("memory_records")} mr
          WHERE mr.is_current IS TRUE AND mr.lifecycle_status = 'approved'
          AND NOT EXISTS (
            SELECT 1 FROM ${table("memory_relations")} rel
            WHERE rel.memory_id = mr.id OR rel.related_memory_id = mr.id
          )
        ) AS missing_relation
    `);
    const relationTypes = await query(pool, `
      SELECT relation_type, count(*)::int AS count
      FROM ${table("memory_relations")}
      GROUP BY relation_type
      ORDER BY count DESC, relation_type ASC
      LIMIT 12
    `);
    return {
      ...(overview.rows[0] ?? {}),
      top_relation_types: relationTypes.rows,
      graph_kind: "memory",
    };
  } finally {
    await closePool(pool);
  }
}

async function selectGraphSeedIds(options: GraphQueryOptions): Promise<string[]> {
  const pool = createPool();
  try {
    const params: unknown[] = [];
    const scopeSql = scopeFilter("mr", options, params);
    if (options.focus_id.startsWith("memory:")) {
      const id = options.focus_id.slice("memory:".length);
      return id ? [id] : [];
    }
    if (options.query) {
      params.push(`%${options.query.toLowerCase()}%`);
      const pattern = params.length;
      params.push(options.limit);
      const limit = params.length;
      const result = await query(pool, `
        WITH seed AS (
          SELECT DISTINCT mr.id,
            CASE
              WHEN lower(COALESCE(mr.title, '')) LIKE $${pattern}::text THEN 90
              WHEN lower(COALESCE(e.name, '')) LIKE $${pattern}::text
                OR lower(COALESCE(e.canonical_name, '')) LIKE $${pattern}::text THEN 75
              WHEN lower(COALESCE(rel.relation_type, '')) LIKE $${pattern}::text THEN 55
              WHEN lower(COALESCE(mr.content, '')) LIKE $${pattern}::text THEN 35
              ELSE 0
            END AS score,
            mr.updated_at
          FROM ${table("memory_records")} mr
          LEFT JOIN ${table("memory_entity_links")} mel ON mel.memory_id = mr.id
          LEFT JOIN ${table("memory_entities")} e ON e.id = mel.entity_id
          LEFT JOIN ${table("memory_relations")} rel ON rel.memory_id = mr.id OR rel.related_memory_id = mr.id
          WHERE mr.is_current IS TRUE AND mr.lifecycle_status = 'approved'${scopeSql}
            AND (
              lower(COALESCE(mr.title, '')) LIKE $${pattern}::text
              OR lower(COALESCE(mr.content, '')) LIKE $${pattern}::text
              OR lower(COALESCE(e.name, '')) LIKE $${pattern}::text
              OR lower(COALESCE(e.canonical_name, '')) LIKE $${pattern}::text
              OR lower(COALESCE(rel.relation_type, '')) LIKE $${pattern}::text
            )
        )
        SELECT id FROM seed ORDER BY score DESC, updated_at DESC LIMIT $${limit}
      `, params);
      return result.rows.map((row) => String(row.id));
    }
    params.push(options.limit);
    const limit = params.length;
    const result = await query(pool, `
      SELECT mr.id
      FROM ${table("memory_records")} mr
      LEFT JOIN ${table("memory_relations")} rel ON rel.memory_id = mr.id OR rel.related_memory_id = mr.id
      WHERE mr.is_current IS TRUE AND mr.lifecycle_status = 'approved'${scopeSql}
      GROUP BY mr.id
      ORDER BY count(rel.id) DESC, mr.updated_at DESC
      LIMIT $${limit}
    `, params);
    return result.rows.map((row) => String(row.id));
  } finally {
    await closePool(pool);
  }
}

async function buildGraphNeighborhood(options: GraphQueryOptions): Promise<PanelGraph> {
  const summary = await buildGraphSummary();
  const seedIds = await selectGraphSeedIds(options);
  if (seedIds.length === 0) return { summary, nodes: [], edges: [] };
  const pool = createPool();
  try {
    const memoryResult = await query(pool, `
      WITH seed(id) AS (SELECT unnest($1::text[])),
      related AS (
        SELECT s.id, 100::real AS graph_score FROM seed s
        UNION
        SELECT rel.related_memory_id AS id, COALESCE(rel.weight, 0.6)::real * 80 FROM ${table("memory_relations")} rel JOIN seed s ON s.id = rel.memory_id
        UNION
        SELECT rel.memory_id AS id, COALESCE(rel.weight, 0.6)::real * 70 FROM ${table("memory_relations")} rel JOIN seed s ON s.id = rel.related_memory_id
        ${options.depth >= 2 ? `
        UNION
        SELECT rel2.related_memory_id AS id, COALESCE(rel2.weight, 0.5)::real * 40
        FROM ${table("memory_relations")} rel1
        JOIN seed s ON s.id = rel1.memory_id OR s.id = rel1.related_memory_id
        JOIN ${table("memory_relations")} rel2 ON rel2.memory_id = rel1.related_memory_id OR rel2.related_memory_id = rel1.memory_id
        ` : ""}
      ),
      ranked AS (
        SELECT id, max(graph_score) AS graph_score
        FROM related
        WHERE id IS NOT NULL
        GROUP BY id
        ORDER BY max(graph_score) DESC
        LIMIT $2
      )
      SELECT mr.id, mr.title, mr.content, mr.scope_type, mr.scope_id, mr.memory_type, mr.updated_at,
             ranked.graph_score, ep.id AS episode_id, ep.title AS episode_title
      FROM ranked
      JOIN ${table("memory_records")} mr ON mr.id = ranked.id
      LEFT JOIN ${table("memory_episodes")} ep ON ep.id = mr.episode_id
      WHERE mr.is_current IS TRUE AND mr.lifecycle_status = 'approved'
      ORDER BY ranked.graph_score DESC, mr.updated_at DESC
    `, [seedIds, options.limit]);
    const memoryIds = memoryResult.rows.map((row) => String(row.id));
    if (memoryIds.length === 0) return { summary, nodes: [], edges: [] };

    const entityResult = await query(pool, `
      SELECT mel.memory_id, mel.role, mel.confidence, e.id, e.entity_type, e.name, e.canonical_name, e.metadata
      FROM ${table("memory_entity_links")} mel
      JOIN ${table("memory_entities")} e ON e.id = mel.entity_id
      WHERE mel.memory_id = ANY($1::text[])
      ORDER BY mel.confidence DESC NULLS LAST, e.name ASC
      LIMIT $2
    `, [memoryIds, Math.min(options.limit * 4, 500)]);
    const relationResult = await query(pool, `
      SELECT id, memory_id, related_memory_id, relation_type, direction, weight, metadata, relation_metadata
      FROM ${table("memory_relations")}
      WHERE memory_id = ANY($1::text[]) AND related_memory_id = ANY($1::text[])
      ORDER BY COALESCE(weight, 0.5) DESC, updated_at DESC
      LIMIT $2
    `, [memoryIds, options.edge_limit]);

    const nodes = new Map<string, PanelGraphNode>();
    const edges = new Map<string, PanelGraphEdge>();
    for (const row of memoryResult.rows) {
      const memoryId = String(row.id);
      pushNode(nodes, {
        id: `memory:${memoryId}`,
        type: "memory",
        label: nodeLabel(row.title, String(row.content ?? memoryId).slice(0, 80)),
        subtitle: `${row.memory_type ?? "memory"} | ${row.scope_type ?? "scope"}:${row.scope_id ?? ""}`,
        score: Number(row.graph_score) || 0,
        metadata: {
          memory_id: memoryId,
          content_preview: nodeLabel(row.content, ""),
          scope_type: row.scope_type,
          scope_id: row.scope_id,
          updated_at: row.updated_at,
        },
      });
      if (row.episode_id) {
        const episodeId = `episode:${row.episode_id}`;
        pushNode(nodes, {
          id: episodeId,
          type: "episode",
          label: nodeLabel(row.episode_title, "episode"),
          subtitle: "episode",
          score: 40,
          metadata: { episode_id: row.episode_id },
        });
        pushEdge(edges, {
          id: `episode-link:${row.episode_id}:${memoryId}`,
          source: episodeId,
          target: `memory:${memoryId}`,
          type: "episode",
          weight: 0.45,
          label: "episode",
        });
      }
    }
    for (const row of entityResult.rows) {
      const entityId = `entity:${row.id}`;
      const memoryId = `memory:${row.memory_id}`;
      pushNode(nodes, {
        id: entityId,
        type: "entity",
        label: nodeLabel(row.canonical_name ?? row.name, "entity"),
        subtitle: String(row.entity_type ?? "entity"),
        score: Number(row.confidence) || 0.5,
        metadata: {
          entity_id: row.id,
          entity_type: row.entity_type,
          role: row.role,
          confidence: row.confidence,
          metadata: row.metadata,
        },
      });
      pushEdge(edges, {
        id: `entity-link:${row.id}:${row.memory_id}`,
        source: entityId,
        target: memoryId,
        type: row.role ?? "mentions",
        weight: Number(row.confidence) || 0.5,
        label: row.role ?? "mentions",
      });
    }
    for (const row of relationResult.rows) {
      pushEdge(edges, {
        id: `relation:${row.id}`,
        source: `memory:${row.memory_id}`,
        target: `memory:${row.related_memory_id}`,
        type: row.relation_type,
        weight: Number(row.weight) || 0.5,
        label: row.relation_type,
      });
    }
    return {
      summary,
      nodes: [...nodes.values()].slice(0, options.limit),
      edges: [...edges.values()].slice(0, options.edge_limit),
    };
  } finally {
    await closePool(pool);
  }
}

export async function buildGraphNeighborhoodFromUrl(url: URL, defaults: { scopeType: string; scopeId: string }): Promise<PanelGraph> {
  return buildGraphNeighborhood(parseGraphQueryOptions(url, defaults));
}

export async function buildGraphMemoryDetails(memoryId: string): Promise<Record<string, unknown>> {
  const id = safeText(memoryId, 220).replace(/^memory:/u, "");
  if (!id) return { error: "缺少必填字段：memory_id（记忆 ID）" };
  const pool = createPool();
  try {
    const memory = await query(pool, `
      SELECT id, title, content, scope_type, scope_id, memory_type, lifecycle_status, review_state, updated_at
      FROM ${table("memory_records")}
      WHERE id = $1
      LIMIT 1
    `, [id]);
    const entities = await query(pool, `
      SELECT e.id, e.entity_type, e.name, e.canonical_name, mel.role, mel.confidence
      FROM ${table("memory_entity_links")} mel
      JOIN ${table("memory_entities")} e ON e.id = mel.entity_id
      WHERE mel.memory_id = $1
      ORDER BY mel.confidence DESC NULLS LAST, e.name ASC
      LIMIT 40
    `, [id]);
    const relations = await query(pool, `
      SELECT id, memory_id, related_memory_id, relation_type, direction, weight
      FROM ${table("memory_relations")}
      WHERE memory_id = $1 OR related_memory_id = $1
      ORDER BY COALESCE(weight, 0.5) DESC, updated_at DESC
      LIMIT 40
    `, [id]);
    return {
      memory: memory.rows[0] ?? null,
      entities: entities.rows,
      relations: relations.rows,
    };
  } finally {
    await closePool(pool);
  }
}
