# memory-xx API Reference

Base path: `/api/memory/xx`

## Authentication

Set the `MEMORY_XX_API_TOKEN` environment variable to enable authentication. When set, all endpoints require one of:

- `Authorization: Bearer <token>`
- `X-API-Key: <token>`

Strict scope is enabled by default. In strict mode, `MEMORY_XX_API_TOKEN` is a
legacy read/write/feedback token and is denied for scoped operations unless the
service is explicitly rolled back with `MEMORY_XX_SCOPE_POLICY_MODE=single_user`.
Use trusted-agent grants or `MEMORY_XX_ADMIN_TOKEN` for scoped automation.

MCP clients should use `MEMORY_XX_MCP_TOKEN`. The MCP server prefers
`MEMORY_XX_MCP_TOKEN` over `MEMORY_XX_API_TOKEN`; the token must belong to a
trusted agent with rows in `trusted_agent_scope_grants` for the scopes it reads,
writes, or reviews. Do not use the admin token as the default MCP token.

## Rate Limiting

- **Limit:** 60 requests per 60 seconds per IP
- **Exceeded:** returns `429 Too Many Requests` with a `Retry-After` header (seconds)

---

## Endpoints

### 1. Recall Query

```
POST /api/memory/xx/recall/query
POST /api/memory/xx/recall
```

Retrieve memories by semantic query.

**Request Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Natural language search text |
| `scope_context.workspace_id` | string | yes | Workspace scope |
| `scope_context.user_id` | string | yes | User scope |
| `scope_context.project_ids` | string[] | no | Restrict to specific projects |
| `scope_context.include_global` | boolean | no | Include global-scope memories |
| `filter_mode` | string | no | `"default"` (default) / `"all"` / `"governance"` / `"shadow_compare"`; non-default modes require `memory:governance_read` or `memory:admin` |
| `limit` | number | no | 1--100, default 6 |
| `offset` | number | no | Pagination offset |
| `explain` | boolean | no | Include ranking explanation in response |

**Response 200**

```json
{
  "results": [
    {
      "memory_id": "string",
      "content": "string",
      "title": "string",
      "summary": "string",
      "score": 0.95,
      "scope_type": "string",
      "scope_id": "string",
      "lifecycle_status": "string",
      "review_state": "string",
      "created_at": "ISO-8601",
      "updated_at": "ISO-8601"
    }
  ],
  "total": 42,
  "query_meta": {}
}
```

**Errors**

| Status | Condition |
|---|---|
| 405 | Method is not POST |
| 503 | Runtime not initialised |
| 400 | Malformed JSON body |
| 403 | non-default `filter_mode` requires `memory:governance_read` or `memory:admin` |
| 403 | strict scope grant missing or legacy token used for scoped access |

---

### 2. Write Memory

```
POST /api/memory/xx/write
```

Create a new memory record.

**Request Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `scopeType` | string | yes | `personal` / `shared` / `user` / `workspace` / `project` / `global`; `run` / `task` / `execution` are runtime-only recall context and cannot be written to the long-term ledger |
| `scopeId` | string | yes | Scope identifier |
| `content` | string | yes | Memory content text |
| `title` | string | no | Short title |
| `summary` | string | no | Brief summary |
| `metadata` | object | no | Arbitrary key-value metadata |
| `dedupeKey` | string | no | Idempotency / deduplication key |
| `requestId` | string | no | Client-supplied request ID |
| `actorId` | string | no | Actor performing the write |
| `lifecycleStatus` | string | no | Initial lifecycle status |
| `reviewState` | string | no | Initial review state |
| `sources` | array | no | Source references |
| `relations` | array | no | Related memory links: `{ "relatedMemoryId": "...", "relationType": "...", "direction": "outbound|bidirectional", "weight": 0.5, "metadata": {} }` |

Initial state is validated before the database write. Creation only accepts
`candidate + pending` or `approved + approved|silent_approved|not_required`.
Invalid state combinations return `400 invalid_create_state`; missing relation
fields return `400`; relation targets that do not exist return `404`.

**Response 201** (created)

```json
{
  "commandType": "memory.create",
  "memoryId": "string",
  "requestId": "string",
  "lifecycleStatus": "string",
  "reviewState": "string",
  "isCurrent": true,
  "version": 1,
  "memoryEventType": "string"
}
```

**Response 200** (replayed / deduplicated) -- same shape, `isCurrent` may be `false`.

**Errors**

| Status | Condition |
|---|---|
| 400 | Missing required fields |
| 409 | Conflict (duplicate `dedupeKey` or `requestId`) |
| 405 | Method is not POST |

---

### 3. Review Memory

```
POST /api/memory/xx/review/memories/:memoryId/:action
```

Transition a memory through its lifecycle.

**URL Parameters**

| Param | Values |
|---|---|
| `:action` | `approve` / `reject` / `archive` / `supersede` / `tombstone` / `update-candidate` |

**Request Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `requestId` | string | no | Request ID |
| `actorId` | string | no | Actor performing the review |
| `content` | string | **yes for `supersede` and `update-candidate`** | Replacement content |
| `title` | string | no | Updated title |
| `summary` | string | no | Updated summary |
| `metadata` | object | no | Updated metadata |
| `dedupeKey` | string | no | Deduplication key for the new record or candidate draft |

`update-candidate` edits the same pending candidate in place. It is only valid
when `lifecycle_status=candidate`, `review_state=pending`, and `is_current=true`.
Approved records must use `supersede`.

**Response 200**

```json
{
  "commandType": "memory.<action>",
  "memoryId": "string",
  "lifecycleStatus": "string",
  "reviewState": "string",
  "isCurrent": true,
  "version": 2
}
```

**Errors**

| Status | Condition |
|---|---|
| 404 | Memory not found |
| 400 | Missing `content` for `supersede` action |
| 409 | State transition conflict |

---

### 3.1 Feedback

Canonical feedback endpoint:

```
POST /api/memory/xx/unified/feedback
```

Deprecated compatibility alias:

```
POST /api/memory/xx/feedback/memories/:memory_id/:action
```

Alias action mapping:

| Alias action | Canonical feedback type |
|---|---|
| `used` | `used` |
| `adopted` | `confirmed` |
| `rejected` / `bad` | `negative` |

The alias is retained for old clients only. New integrations should use
`/api/memory/xx/unified/feedback`.

---

### 4. Resolve Scope Plan

```
POST /api/memory/xx/orchestrator/resolve-scope-plan
```

Resolve scope hints into a concrete scope plan.

**Request Body**

```json
{
  "recall_request": {},
  "write_scope_hint": {}
}
```

**Response 200** -- scope plan resolution result.

---

### 5. Orchestrator Write

```
POST /api/memory/xx/orchestrator/write-memory
```

High-level write combining scope resolution and memory creation.

**Request Body**

```json
{
  "command": { "scopeType": "...", "scopeId": "...", "content": "..." }
}
```

**Response 200** -- write result (same shape as endpoint 2).

---

### 6. Orchestrator Recall

```
POST /api/memory/xx/orchestrator/recall-memory
```

High-level recall combining scope resolution and query.

**Request Body**

```json
{
  "request": { "query": "...", "scope_context": {} }
}
```

**Response 200** -- recall results (same shape as endpoint 1).

---

### 7. Orchestrator Summarize

```
POST /api/memory/xx/orchestrator/summarize-memory
```

Summarise memories matching the request.

**Request Body**

```json
{
  "request": {},
  "max_items": 50
}
```

**Response 200** -- summary result.

---

### 8. Orchestrator Forget

```
POST /api/memory/xx/orchestrator/forget-memory
```

Archive or tombstone a memory.

**Request Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `requestId` | string | no | Request ID |
| `actorId` | string | no | Actor |
| `memoryId` | string | yes | Target memory |
| `mode` | string | yes | `"archive"` or `"tombstone"` |

**Response 200** -- forget result.

---

### 9. Audit Consistency

```
POST /api/memory/xx/orchestrator/audit-memory-consistency
```

Run a consistency audit across Postgres and Qdrant.

**Request Body**

```json
{
  "include_records": false
}
```

**Response 200** -- audit result with mismatch counts.

---

### 10. Repair Consistency

```
POST /api/memory/xx/orchestrator/repair-memory-consistency
```

Repair consistency issues found by the audit endpoint.

**Request Body**

```json
{
  "dry_run": true
}
```

`dry_run` defaults to `true`. Set to `false` to apply repairs.

**Response 200** -- repair result with actions taken or planned.

---

### 11. Conversation Events And Ingest

Conversation event append and extraction ingest use different schemas.

```
POST /api/memory/xx/conversation/events
POST /api/memory/xx/conversation/ingest
```

`/conversation/events` accepts event-style payloads for the conversation
listener. `/conversation/ingest` starts extraction from chat messages and
requires `messages`:

```json
{
  "messages": [
    { "role": "user", "content": "Remember that..." }
  ],
  "scope_type": "project",
  "scope_id": "memory-xx",
  "agent_id": "codex-main"
}
```

If `messages` is missing or invalid, the endpoint returns `400` with an
`expected` schema example.

---

### 12. Skills Execute

```
POST /api/memory/xx/skills/execute
```

Canonical request:

```json
{
  "skill_id": "health_check",
  "params": {
    "include_records": false
  }
}
```

For compatibility, flat payloads are also accepted. When `params` is missing,
all top-level fields except `skill_id`, `id`, and `params` are treated as
parameters, and the response marks `params_source: "flat_payload"`.

```json
{
  "skill_id": "health_check",
  "include_records": false
}
```

---

### 13. Health Check

```
GET /health
```

**Response 200** (healthy)

```json
{
  "status": "ok",
  "runtime_initialised": true,
  "runtime_profile": "core",
  "wrapper_mode": "full",
  "runtime_selection": "qdrant-primary",
  "dependency_profile": {
    "mode": "core",
    "required_components": ["wrapper", "postgres", "redis", "qdrant", "embedding_proxy", "projector"],
    "expected_components": [],
    "optional_components": ["fastpath", "lexical", "reranker", "graph_recall"]
  },
  "vector": { "available": true, "backend": "qdrant", "primary_backend": "qdrant" },
  "qdrant": { "configured": true, "collection_name": "memory-xx-active" },
  "redis": { "configured": true, "available": true },
  "embedding_generation": { "configured": true, "ok": true },
  "embedding_provider": { "model": "Qwen3-Embedding-8B", "dims": 4096, "matches_active_generation": true },
  "config": {}
}
```

**Response 503** -- `status: "degraded"` when a critical dependency is unavailable.

---

### 14. Metrics

```
GET /metrics
```

**Response 200**

```json
{
  "http_requests_total": 1234,
  "http_request_duration_ms": {
    "count": 1234,
    "sum": 56789,
    "avg": 46.1,
    "min": 1.2,
    "max": 320.5
  }
}
```

---

## Lifecycle State Machine

```
candidate --> approved
candidate --> rejected

approved --> archived
approved --> superseded
approved --> tombstoned
```

- `filter_mode: "default"` returns only `approved` records.
- `filter_mode: "all"` returns records in any state and requires `memory:governance_read` or `memory:admin`.
- `filter_mode: "governance"` returns records pending review (`candidate`) and requires `memory:governance_read` or `memory:admin`.
- `filter_mode: "shadow_compare"` returns all for comparison purposes and requires `memory:governance_read` or `memory:admin`.
