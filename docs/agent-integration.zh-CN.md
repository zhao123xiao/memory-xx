# Agent / MCP 接入

memory-xx 可以作为多 Agent 共享记忆底座。每个 Agent 应使用独立 trusted token，并通过 scope grant 限定能读写的 project、workspace、user 或 global scope。

## Token 边界

- `MEMORY_V2_API_TOKEN`：普通 API token。
- `MEMORY_V2_MCP_TOKEN`：MCP 客户端推荐 token，应绑定 trusted agent 和 scope grants。
- `MEMORY_V2_ADMIN_TOKEN`：管理操作 token，不应作为默认 Agent/MCP token。

MCP 客户端建议使用 `MEMORY_V2_MCP_TOKEN`。这个 token 应属于 trusted agent，并且必须有对应的 `trusted_agent_scope_grants`。

## Agent 能力

- scope-aware recall
- write / smart-write
- list pending
- approve / reject pending
- feedback / recall-feedback
- orchestrator write / recall / summarize / forget / repair

普通 Agent 默认只能访问被授权的 project / workspace / user scope。`global` 写入和 real update/supersede/apply 不建议默认开放。

## 常用命令

```bash
TMPDIR=/tmp npm run memory:agent -- create codex-main --project=memory-xx
TMPDIR=/tmp npm run memory:agent -- create claude-code-main --project=memory-xx
TMPDIR=/tmp npm run memory:trusted-agent -- --json
TMPDIR=/tmp npm run memory:agent -- audit
```

## 验证

```bash
TMPDIR=/tmp npm run test:mcp-user-flow
TMPDIR=/tmp npm run test:multi-agent-contract
```
