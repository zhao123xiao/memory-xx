# memory-xx 对齐 memory-v2 开源镜像源码审计报告

生成时间：2026-06-11 Asia/Shanghai  
审计对象：`/home/xiaoxiao/services/memory-v2` 与 `/home/xiaoxiao/services/memory-xx`  
目标定位：`memory-xx` 应成为保留开源安全边界的 `memory-v2` 完整功能镜像，而不是功能子集。

> 2026-06-13 更新：本报告的原始缺口清单记录的是 2026-06-11 的迁移前状态。后续迁移已补齐原报告列出的核心源码、脚本、迁移、systemd 和测试入口缺口。当前 authoritative 状态应以本更新段和当前工作树验证结果为准；下文第 4、5、7 节保留为历史追踪材料，不能再直接当作当前缺口清单使用。

## 0. 2026-06-13 当前状态更新

本次重新按当前工作树做规范化源码对比，规范化规则仍将 `memory-v2`、`MEMORY_V2`、`/api/memory/v2`、`klee-memory-v2-wrapper`、`openclaw-*` 等私有或旧命名映射到 `memory-xx` 的开源表达；`.bak`、`.pre-bak-restore`、`reports/` 等 ignored 备份/运行产物不作为功能 parity 要求。

当前结论：

- `app/`、`scripts/`、`tests/`、`migrations/`、`systemd/`、`configs/` 范围内，`memory-xx` 相对 `memory-v2` 的规范化缺失文件数为 0。
- 包含 `docs/` 后仍有 11 个 `memory-v2` 文档/历史计划类文件未迁移；这些文件不是运行时功能入口。
- 原报告列出的 11 个治理模块、`pending-review-webhook`、`0034_governance_lock_unique_index.sql`、admin 脚本、Memory OS dashboard、knowledge directory ingest、MCP stdio delay 脚本均已在 `memory-xx` 当前工作树存在。
- 原报告标注的关键占位链路已经替换：`adaptive-retrieval-apply`、`graph-relation-repair-executor`、`human-review-apply`、`procedural-promotion-candidates` 均具备对应实现和测试覆盖。
- `memory:evolve` 仍保持 report-only/dry-run first 定位；这与开源镜像的 dangerous 能力边界一致，不能简单视为功能缺失。若未来要求真实 evolve apply，需要新增显式 `--apply --plan`、审计记录和回滚证据。

当前验证证据：

| 验证项 | 结果 |
| --- | --- |
| 规范化文件对比：`app/ scripts/ tests/ migrations/ systemd/ configs/` | 缺失文件数 0 |
| `package.json` script key 对比 | `memory-v2` 脚本在 `memory-xx` 中缺失数 0；`memory-xx` 额外保留 `audit:prod`、`verify:open-source`、`memory:parity-audit` |
| `TMPDIR=/tmp npm run typecheck` | 通过 |
| `TMPDIR=/tmp node --import tsx --test tests/l6-prod-load-harness.test.ts` | 3 tests，3 pass；L6 cleanup 已覆盖 429 retry-after 有界重试 |
| `TMPDIR=/tmp node --import tsx --test tests/ci-workflow-plan.test.ts tests/memory-parity-audit-script.test.ts` | 10 tests，10 pass；CI 条件式接入 parity audit，CLI 覆盖规范化映射、缺失失败和 source 缺失失败 |
| `TMPDIR=/tmp npm run memory:parity-audit -- --json --fail-on-missing` | `ok=true`；缺失文件 0；`memory-v2` 独有脚本 0；私有残留 0 |
| `TMPDIR=/tmp node --import tsx --test tests/human-review-apply.test.ts tests/procedural-promotion-candidates.test.ts` | 11 tests，11 pass |
| `TMPDIR=/tmp node --import tsx --test tests/open-source-readiness.test.ts tests/open-source-release.test.ts` | 19 tests，19 pass |
| `TMPDIR=/tmp npm run open-source:preaudit -- --json --fail-on-blockers` | `ok=true`，0 blockers，0 warnings |
| `TMPDIR=/tmp npm test` | 883 tests，880 pass，0 fail，3 skipped |
| `TMPDIR=/tmp npm run verify:open-source` | 通过；脚本已改为 `--fail-on-blockers`，preaudit 为 `ok=true`、0 blockers、0 warnings |
| `TMPDIR=/tmp npm run test:prod-e2e` | `ok=true`；run_id `a85543a3`；8/8 checks passed；`tombstone:qdrant-projection`、PG tombstone 与 recall invisibility 均通过 |
| `TMPDIR=/tmp npm run test:load` | `ok=true`；run_id `05447748`；3/3 checks passed；50 requests，0 5xx/429/4xx，p99 215ms；cleanup 14/14 tombstoned |
| `TMPDIR=/tmp npm run test:multi-agent-contract` | `ok=true`；run_id `1f1c40af`；10/10 checks passed；shared recall isolation 与 cleanup 均通过 |
| `TMPDIR=/tmp npm run test:knowledge-e2e` | `ok=true`；run_id `3a5ea9fa`；6/6 checks passed，knowledge search、unified recall knowledge opt-in 与 source disambiguation 均通过 |
| `TMPDIR=/tmp npm run test:data-governance` | `ok=true`；run_id `2c1cd9a8`；3/3 checks passed，production test pollution 为 0 |

当前剩余工作 / 风险：

1. `memory:evolve` 仍是 report-only/dry-run first；如果要求与 `memory-v2` 的真实 evolve apply 完全等价，需要新增显式 `--apply --plan`、审计记录、失败诊断和回滚证据。
2. L5 曾记录的 Qdrant tombstone 投影延迟已修复：orchestrator `forget-memory` 路径现在与 review 生命周期路径一样传入 post-commit projection/cache dependencies，并新增 HTTP 集成回归测试。
3. L6 的 cleanup 已对 429 rate limit 响应增加基于 `retry_after_seconds` / `Retry-After` 的有界重试，并在本次独立 runtime 中验证 3/3 通过；连续门禁验证仍建议提高本地测试限流或分阶段等待窗口恢复，避免压测与清理共用限流桶造成长等待。
4. 将 `docs/` 中仍缺的历史/内部计划文档评估为“不迁移且记录原因”或改写为开源安全文档。
5. 将本次 L5/L6/L12/L13/L14 结果纳入发布报告或 release checklist，便于开源发布前复核。

## 1. 审计范围与方法

本报告基于两个仓库当前工作树的源码状态，不以远端分支、历史计划文档或 README 宣称为准。

审计采用以下方法：

- 对 `app/`、`scripts/`、`tests/`、`migrations/`、`systemd/`、`configs/` 做源码级文件对比。
- 对比时把 `memory-v2`、`MEMORY_V2`、`/api/memory/v2`、`klee-memory-v2-wrapper` 等私有命名规范化为 `memory-xx`、`MEMORY_XX`、`/api/memory/xx`、`memory-xx-wrapper`。
- 检查 `package.json` 脚本入口差异。
- 搜索简化、占位、未实现和私有命名残留：`Simplified version`、`placeholder`、`not implemented`、`requires governance repository integration`、`successor_placeholder`、`MEMORY_V2`、`/api/memory/v2`。
- 不运行 migrate、apply、repair、auto-update 等会修改真实数据或运行状态的命令。

## 2. 总体结论

`memory-xx` 当前已经补齐原始审计报告中列出的主要源码、脚本、迁移、systemd、config 和测试入口缺口。按当前工作树做规范化对比后，运行时功能入口层面的缺失文件数为 0；写入、召回、审批、Postgres 账本、Qdrant 投影、Redis 缓存/锁、MCP/HTTP 接口、知识库、治理报告、图谱维护、Memory OS 控制面和开源校验都已经存在。

如果目标是作为 `memory-v2` 的完整功能开源镜像，当前重点已经从“补缺失模块”转为“稳定发布基线”：

- 继续保持 `memory-xx` 的开源安全边界：`MEMORY_XX_*`、`/api/memory/xx`、通用示例路径、无私有 `.env`、无真实 token、无个人默认 scope。
- 将 historical audit 中的旧缺口表述收敛为当前态，避免开源文档误导维护者。
- 对 dangerous apply 类能力保持 dry-run first；真实写入必须显式 plan、审计记录和可诊断失败。
- 高层门禁仍应在发布前完整跑通，尤其是 L5/L6/L12/L13/L14 这类需要外部服务的集成证明链。

当前可粗略判断：

| 维度 | 当前状态 |
| --- | --- |
| 核心 write/recall/review 链路 | 已具备 |
| 高级治理闭环 | 已迁入主要模块，需持续用门禁证明 |
| 图谱维护能力 | 已具备候选、报告、repair plan/apply 入口 |
| Memory OS / 控制面增强 | 已具备 dashboard 和 readiness 报告入口 |
| apply 型治理能力 | 已替换关键占位；dangerous 能力保持 dry-run first |
| 开源边界 | 已通过 open-source verify |
| 完整镜像成熟度 | 接近发布基线，剩余为文档收敛和外部依赖门禁稳定性 |

## 3. 已验证证据

当前针对 `memory-xx` 的验证结果：

| 验证项 | 结果 |
| --- | --- |
| `TMPDIR=/tmp npm run typecheck` | 通过 |
| `TMPDIR=/tmp npm test` | 883 tests，880 pass，0 fail，3 skipped |
| `TMPDIR=/tmp npm run verify:open-source` | 通过；preaudit 0 blockers / 0 warnings |
| `npm audit --omit=dev --registry=https://registry.npmjs.org` | 0 vulnerabilities |

本次源码对比结果：

| 对比项 | 结果 |
| --- | ---: |
| `memory-xx` 缺失的规范化文件 | 0 |
| 其中 `app/governance` 缺失模块 | 0 |
| `memory-v2` 独有 package script | 0 |
| `memory-xx` 独有 package script | 3 |

`memory-xx` 独有脚本入口：

- `audit:prod`
- `verify:open-source`
- `memory:parity-audit`

## 4. 文件对齐状态

### 4.1 治理模块

原始审计报告列出的 11 个 `memory-v2` 治理模块，当前均已在 `memory-xx` 工作树中存在：

| 模块 | 当前状态 |
| --- | --- |
| `graph-debt-backfill-policy` | 已迁入并有测试覆盖 |
| `graph-orphan-report` | 已迁入并有测试覆盖 |
| `graph-successor-discovery-candidates` | 已迁入并有测试覆盖 |
| `graph-test-fixture` | 已迁入 |
| `memory-link-candidates` | 已迁入并有测试覆盖 |
| `memory-os-readiness-report` | 已迁入并有测试覆盖 |
| `pending-approval-evidence-report` | 已迁入并有测试覆盖 |
| `temporal-transition-candidates` | 已迁入并有测试覆盖 |
| `temporal-validity-debt-report` | 已迁入并有测试覆盖 |
| `topic-alias-candidates` | 已迁入并有测试覆盖 |
| `topic-normalization-plan` | 已迁入并有测试覆盖 |

### 4.2 Review / migration / script / systemd 入口

原始审计报告列出的关键入口当前均已补齐或转换为开源安全命名：

| 类别 | 文件 | 当前状态 |
| --- | --- |
| Review webhook | `app/review/pending-review-webhook.ts` | 已存在 |
| Migration | `migrations/0034_governance_lock_unique_index.sql` | 已存在 |
| Admin script | `scripts/admin/enable-auto-approval.ts` | 已存在 |
| Admin script | `scripts/admin/register-agent.ts` | 已存在 |
| Control panel | `scripts/control-panel/memory-os-dashboard.ts` | 已存在 |
| Knowledge import | `scripts/knowledge/ingest-directory.ts` | 已存在 |
| MCP diagnostic | `scripts/test-mcp-stdio-delay.ts` | 已存在 |
| Systemd wrapper | `systemd/memory-xx-wrapper.service` | 已使用通用开源命名 |

### 4.3 测试证明链

原始审计报告指出的测试缺口已经大幅补齐。当前 `npm test` 统计为 883 tests，880 pass，0 fail，3 skipped，覆盖以下能力：

- 自适应召回校准与 apply 脚本。
- cache invalidation worker 脚本。
- consolidation candidates / consolidation foundation。
- context hygiene、pending approval evidence、Memory OS readiness。
- conversation observer metadata 与 worker batching。
- dream runtime。
- graph debt、graph orphan、graph successor discovery、graph retriever、graph repair plan/apply。
- knowledge directory ingest、knowledge scope grant、knowledge search fallback。
- L5/L6/L12/L13/L14 测试层 harness。
- memory relation repository / vocabulary / source repository。
- pending review webhook。
- policy feedback backprop。
- qdrant runtime health。
- recall orchestrator hotpath、record mapping、recent approved fallback、vector retriever。
- topic alias / topic normalization / temporal validity / temporal transition。

剩余测试工作主要是发布前在真实依赖环境中重复跑通高层 harness，而不是补缺失测试文件。

## 5. 占位实现替换状态

### 5.1 Adaptive retrieval apply

文件：

- `app/governance/adaptive-retrieval-apply.ts`
- `scripts/memory-adaptive-retrieval-apply.ts`

现状：

- 已替换原先的占位实现。
- CLI 默认 dry-run，真实 apply 需要显式 plan file。
- 实现包含策略 override、治理 action 记录和危险 selector 防护。

验证：

- `tests/adaptive-retrieval-apply.test.ts`
- `tests/adaptive-retrieval-apply-script.test.ts`

### 5.2 Graph relation repair executor

文件：

- `app/governance/graph-relation-repair-executor.ts`

现状：

- 已替换 `successor_placeholder` 占位逻辑。
- repair apply 从 plan 读取真实 successor / relation 更新目标。
- 具备 graph repair plan、executor 和 apply script 测试覆盖。

验证：

- `tests/graph-relation-repair-plan.test.ts`
- `tests/graph-relation-repair-executor.test.ts`
- `tests/graph-relation-repair-apply-script.test.ts`

### 5.3 Memory evolve apply

文件：

- `app/governance/memory-evolve-report.ts`

现状：

- `memory:evolve` 在 `memory-v2` 与 `memory-xx` 中均保持 report-only / dry-run first 定位。
- `memory-xx` 当前错误信息为：`memory:evolve apply is disabled; run --dry-run or use explicit plan-specific apply commands`。

判断：

- 这不是当前相对 `memory-v2` 的功能缺口。
- 如果未来要开放真实 evolve apply，应新增显式 `--apply --plan`、治理审计、失败诊断和回滚证据。

### 5.4 其他曾标注为简化版的模块

以下模块已在当前测试链中覆盖，当前不再按“缺失功能”处理：

- `app/shared/cognitive-type.ts`
- `app/recall/context-bundle.ts`
- `app/governance/adaptive-retrieval-calibration.ts`
- `app/governance/extraction-recall-eval.ts`
- `app/governance/graph-relation-repair-plan.ts`
- `app/governance/human-review-apply.ts`
- `app/governance/procedural-promotion-candidates.ts`
- `app/governance/recall-quality-feedback.ts`

后续如果发现 `memory-v2` 新增行为，应继续按源码对比和行为测试迁移，而不是只按文件存在判定。

## 6. 开源镜像迁移边界

`memory-xx` 需要完整功能，但不能直接照搬 `memory-v2` 的私有运行环境。

禁止迁入或默认化：

- 私有 `.env` 内容。
- 私有绝对路径。
- 实际凭据、API token、secret file 路径。
- 个人 scope、个人 workspace、个人 agent 默认值。
- `klee` 作为通用默认作者。
- OpenClaw 私有运行绑定作为唯一推荐路径。
- 真实生产数据、真实审计记录、真实本机端口假设。

必须保持：

- 环境变量前缀使用 `MEMORY_XX_*`。
- API 路径使用 `/api/memory/xx`。
- 示例路径使用 `<user>`、`<workspace>`、`<project>` 等占位。
- 危险命令默认 dry-run，真实 apply 必须显式 opt-in。
- 开源文档当前应标注为 public preview release candidate；完整 parity、开源验证和运行时发布门禁已经在 `docs/open-source-release-readiness-2026-06-13.md` 中记录。

## 7. 当前对齐任务分级

### P0：发布前门禁稳定

当前 P0 不再是迁移缺失模块，而是把已迁移能力稳定成可发布基线：

1. 在真实依赖环境中重新跑通 L5、L6、L12、L13、L14，并保存可复现结果。
2. 保持 L6 cleanup 的 429 retry/backoff 行为，避免压测后测试污染残留影响后续门禁。
3. 确认 Qdrant tombstone 投影、knowledge fallback、strict scope、pending review webhook 等高风险路径在集成环境中持续通过。
4. 发布前执行 `verify:open-source`，确保没有私有命名、真实 token、私有路径或 `.env` 泄漏。

### P1：文档与成熟度收敛

1. 将历史计划/审计文档中仍描述旧缺口的段落改成当前态，或明确标注为历史材料。
2. 更新 `configs/feature-maturity.json` 和 `docs/feature-maturity.zh-CN.md`，让 stable/beta/experimental/dangerous 与真实实现和门禁证据一致。
3. README 和 features 文档继续声明 `memory-xx` 是完整开源镜像目标；当前已通过发布门禁，公开状态应保持 public preview release candidate，同时继续标明 dangerous apply 风险边界。
4. 将 `docs/` 中仍缺的内部计划文档评估为“不迁移且记录原因”或改写为开源安全文档。

### P2：可复现 parity 门禁

1. 已新增 `memory:parity-audit` 脚本，固化当前规范化文件对比、package script 对比和私有残留扫描；CI 已在检测到 sibling `../memory-v2` 时执行强门禁，公开 CI 中无私有源 checkout 时会显式跳过。
2. parity 门禁应排除 `.bak`、`.pre-bak-restore`、`reports/` 等备份/运行产物，并保留 `memory-v2` 私有命名到 `memory-xx` 开源命名的规范化映射。
3. 门禁失败时输出按目录分组的缺口清单，便于后续 `memory-v2` 新增能力继续同步到 `memory-xx`。

### P3：未来增强

1. 如果未来要求真实 `memory:evolve apply`，新增显式 `--apply --plan`、治理审计、失败诊断和回滚证据。
2. 对 dangerous apply/repair/rollback 能力继续保持 dry-run first，真实写入必须显式 opt-in。
3. 持续跟踪 `memory-v2` 新增功能，按“源码迁移 + 开源边界转换 + 测试证明链”同步。

## 8. 建议验收门禁

`memory-xx` 达到 `memory-v2` 完整开源镜像前，应至少通过以下门禁：

```bash
TMPDIR=/tmp npm run typecheck
TMPDIR=/tmp npm test
TMPDIR=/tmp npm run verify:open-source
TMPDIR=/tmp npm run test:prod-e2e
TMPDIR=/tmp npm run test:load
TMPDIR=/tmp npm run test:multi-agent-contract
TMPDIR=/tmp npm run test:knowledge-e2e
TMPDIR=/tmp npm run test:data-governance
```

对 dangerous apply 能力，还需要额外验收：

- dry-run 不写数据库、不写 Qdrant、不改变 runtime settings。
- `--apply` 必须要求显式参数或 plan file。
- apply 必须写入治理审计记录。
- apply 失败必须可诊断，不能静默部分成功。
- 对全局 scope、批量 tombstone、批量 rewrite、关系 retarget 等高风险操作必须有测试覆盖。

## 9. 可复现审计命令

以下命令可复现本报告的主要审计数据。

首选门禁命令：

```bash
TMPDIR=/tmp npm run memory:parity-audit -- --json --fail-on-missing
```

规范化文件缺失统计：

```bash
node - <<'NODE'
const fs = require('fs');
const path = require('path');

const ignored = (p) => /\.bak$|\.pre-bak-restore$|(^|\/)reports\//u.test(p);

function walk(root, rel = '') {
  const out = [];
  for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = path.join(rel, ent.name).replaceAll('\\', '/');
    if (ent.name === 'node_modules' || ent.name === '.git' || ignored(r)) continue;
    if (ent.isDirectory()) out.push(...walk(root, r));
    else out.push(r);
  }
  return out;
}

function norm(p) {
  return p
    .replace(/^scripts\/klee-memory-v2-wrapper\.ts$/u, 'scripts/memory-xx-wrapper.ts')
    .replaceAll('memory-v2', 'memory-xx')
    .replaceAll('memory_v2', 'memory_xx')
    .replaceAll('MEMORY_V2', 'MEMORY_XX')
    .replaceAll('/api/memory/v2', '/api/memory/xx')
    .replaceAll('klee-memory-v2-wrapper', 'memory-xx-wrapper')
    .replaceAll('openclaw-memory-xx-wrapper', 'memory-xx-wrapper')
    .replaceAll('openclaw-qdrant-projector-worker', 'memory-xx-qdrant-projector-worker');
}

const roots = ['app', 'scripts', 'tests', 'migrations', 'systemd', 'configs'];
const missing = [];
for (const root of roots) {
  const v2 = walk(`/home/xiaoxiao/services/memory-v2/${root}`).map((p) => norm(`${root}/${p}`));
  const xx = new Set(walk(`/home/xiaoxiao/services/memory-xx/${root}`).map((p) => `${root}/${p}`));
  for (const p of v2) if (!xx.has(p)) missing.push(p);
}

console.log(JSON.stringify({ missing_count: missing.length, missing }, null, 2));
NODE
```

脚本入口差异：

```bash
node - <<'NODE'
const fs=require('fs');
function scripts(p){return Object.keys(JSON.parse(fs.readFileSync(p,'utf8')).scripts).sort();}
const v=scripts('/home/xiaoxiao/services/memory-v2/package.json');
const x=scripts('/home/xiaoxiao/services/memory-xx/package.json');
console.log(JSON.stringify({only_in_memory_v2:v.filter(k=>!x.includes(k)), only_in_memory_xx:x.filter(k=>!v.includes(k))}, null, 2));
NODE
```

简化、占位、未实现和私有命名残留扫描：

```bash
rg -n "Simplified version|placeholder|not implemented|requires governance repository integration|successor_placeholder|MEMORY_V2|/api/memory/v2" app scripts tests configs systemd
```

## 10. 当前优先级结论

`memory-xx` 当前已经从“补齐 memory-v2 功能缺口”进入“稳定开源镜像发布基线”的阶段。下一步不应继续堆新功能，而应优先完成：

1. 重跑并归档真实依赖环境下的 L5、L6、L12、L13、L14 验收结果。
2. 在内部/本地有 `../memory-v2` checkout 的环境中持续运行 CI parity audit，防止后续 `memory-v2` 新增功能后 `memory-xx` 再次漂移。
3. 收敛 README、features、feature maturity 和历史审计文档，避免当前态与历史缺口描述混杂。
4. 保持开源安全边界：无私有 `.env`、无真实 token、无个人 scope 默认值、无 `MEMORY_V2` / `/api/memory/v2` 运行时残留。
