import type { KnowledgeGrantResourceType, KnowledgeScopeGrantRow } from "../schema/tables";
import {
  type WriteTransactionContext,
  isInMemoryTransactionContext
} from "../tx/write-transaction";
import { mapKnowledgeScopeGrantRow } from "./support-row-mappers";
import type { JsonObject } from "../../shared";

export interface CreateKnowledgeScopeGrantInput {
  readonly agentId: string;
  readonly resourceType: KnowledgeGrantResourceType;
  readonly resourceId: string;
  readonly permissions: readonly string[];
  readonly createdBy: string;
  readonly expiresAt?: string | null;
  readonly metadata?: JsonObject;
}

export class KnowledgeScopeGrantRepository {
  async create(
    tx: WriteTransactionContext,
    input: CreateKnowledgeScopeGrantInput
  ): Promise<KnowledgeScopeGrantRow> {
    const now = tx.now();
    const row: KnowledgeScopeGrantRow = {
      id: tx.nextId("knowledge_scope_grant"),
      agentId: input.agentId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      permissions: [...input.permissions],
      expiresAt: input.expiresAt ?? null,
      createdBy: input.createdBy,
      revokedAt: null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now
    };

    if (isInMemoryTransactionContext(tx)) {
      const index = tx.state.knowledgeScopeGrants.findIndex((grant) =>
        grant.agentId === row.agentId &&
        grant.resourceType === row.resourceType &&
        grant.resourceId === row.resourceId &&
        grant.revokedAt === null
      );
      if (index >= 0) {
        tx.state.knowledgeScopeGrants[index] = row;
      } else {
        tx.state.knowledgeScopeGrants.push(row);
      }
      return row;
    }

    const [created] = await tx.query(
      `
        INSERT INTO knowledge_scope_grants (
          id, agent_id, resource_type, resource_id, permissions, expires_at,
          created_by, revoked_at, metadata, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5::text[], $6::timestamptz, $7, NULL, $8::jsonb, $9::timestamptz, $9::timestamptz)
        ON CONFLICT (agent_id, resource_type, resource_id) WHERE revoked_at IS NULL
        DO UPDATE SET
          permissions = EXCLUDED.permissions,
          expires_at = EXCLUDED.expires_at,
          created_by = EXCLUDED.created_by,
          metadata = EXCLUDED.metadata,
          updated_at = EXCLUDED.updated_at
        RETURNING *
      `,
      [
        row.id,
        row.agentId,
        row.resourceType,
        row.resourceId,
        [...row.permissions],
        row.expiresAt,
        row.createdBy,
        JSON.stringify(row.metadata),
        now
      ]
    );
    return mapKnowledgeScopeGrantRow(created);
  }

  async hasReadGrant(
    tx: WriteTransactionContext,
    input: {
      readonly agentId: string;
      readonly resourceType: KnowledgeGrantResourceType;
      readonly resourceId: string;
    }
  ): Promise<boolean> {
    const now = tx.now();
    if (isInMemoryTransactionContext(tx)) {
      return tx.state.knowledgeScopeGrants.some((grant) =>
        grant.agentId === input.agentId &&
        grant.resourceType === input.resourceType &&
        (grant.resourceId === input.resourceId || grant.resourceId === "*") &&
        grant.revokedAt === null &&
        (grant.expiresAt === null || grant.expiresAt > now) &&
        (grant.permissions.includes("memory:read") || grant.permissions.includes("memory:admin"))
      );
    }

    const [row] = await tx.query<{ ok: boolean }>(
      `
        SELECT true AS ok
        FROM knowledge_scope_grants
        WHERE agent_id = $1
          AND resource_type = $2
          AND (resource_id = $3 OR resource_id = '*')
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > $4::timestamptz)
          AND ('memory:read' = ANY(permissions) OR 'memory:admin' = ANY(permissions))
        LIMIT 1
      `,
      [input.agentId, input.resourceType, input.resourceId, now]
    );
    return Boolean(row?.ok);
  }
}
