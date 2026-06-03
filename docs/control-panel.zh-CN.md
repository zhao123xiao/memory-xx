# 控制面板

memory-xx 包含一套本地 Web 控制面板：

```bash
TMPDIR=/tmp npm run memory:control-panel
```

启动后命令行会输出本地访问地址，例如：

```text
memory-xx control panel: http://127.0.0.1:<port>/
```

## 主要能力

- **运行总览**：wrapper、PostgreSQL、Redis、Qdrant、embedding upstream、embedding proxy、projector、fastpath、lexical sidecar、reranker、outbox、cache invalidation 等组件状态。
- **写入/召回链路追踪**：展示 write flow、recall flow、candidate record、approval state、Qdrant projection、lexical/vector/graph recall 等链路证据。
- **审批治理**：查看 pending、自动审批容量、policy override、production guard、candidate-only、scope-level bypass 和 auto-approval runtime controls。
- **服务开关**：对部分受控服务和 conversation monitor 做 enable/disable 操作；高风险项需要显式开关，不会默认扩大生产权限。
- **热更新设置**：通过 runtime settings registry 调整 Redis TTL、rate limit、write ticket TTL、semantic lock、smart-write Qdrant preflight、reranker timeout、graph health TTL、自动审批阈值等热生效参数。
- **重启计划**：对 query embedding cache、projector worker interval/batch/retry、DB pool、conversation worker interval 等需要重启的参数，控制面板会标记 `requires_restart` 并生成 restart plan。
- **图谱视图**：提供 `知识图谱` 和 `代码图谱` 切换，支持按 scope、query、depth、limit、代码根目录加载图谱。
- **平台与安全检查**：展示 Linux / WSL / Windows / Docker 平台预检、secrets audit、deployment preflight、migration checks。
- **运行快照与审计**：记录 runtime snapshot、runtime settings audit、runtime observability rows、code graph project snapshots。

## 安全级别

控制面板的可调项会标注安全级别：

- `safe`：UI 或低风险参数。
- `guarded`：影响召回、写入、缓存或健康门禁，需要理解影响后调整。
- `high-risk`：涉及 global、real update apply、PII、candidate-only bypass 等生产权限，默认不建议打开。

## 热插拔边界

热插拔配置不是无限制动态修改。每个配置项会明确：

- `hot_reloadable=true`：新请求或新策略读取会直接生效。
- `requires_restart=true`：需要重启对应 service。
- `source=runtime_json`：写入 runtime JSON，由运行时读取。
- `source=env`：来自环境变量，只读或需要重启服务后生效。

当前控制面板是本地运维工具，建议只绑定 `127.0.0.1`，不要直接暴露到公网。
