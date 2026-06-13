# memory-v2 完善 memory-xx 实施清单

> **状态：历史材料 / 已取代（2026-06-13）** — 本清单记录的是迁移前规划，不代表当前 `memory-xx` 运行时缺口。当前状态以 `docs/memory-v2-full-feature-parity-audit-2026-06-11.md` 和 `docs/open-source-release-readiness-2026-06-13.md` 为准。

生成时间：2026-06-09 Asia/Shanghai  
目标仓库：`memory-xx`  
依据：`memory-v2 功能成熟度真实判定报告`（2026-06-09）与当前 `memory-xx` 工作树只读核对。  

> 这是一份实施清单，不是代码迁移结果。执行时必须先保留 `memory-xx` 的开源边界：使用 `MEMORY_XX_*` 环境变量、`/api/memory/xx` API 路径、通用示例路径，禁止把私有运行路径、真实 scope、真实 token 或个人运行数据写入公开文档。

## 当前真实差距

`memory-xx` 不是空镜像，已经包含多数核心能力。当前核对结果：

| 项 | memory-v2 | memory-xx | 差距 |
|---|---:|---:|---|
| 相关脚本 key | 128 | 117 | 缺 11 个脚本 key |
| 成熟度公开文档 | 有真实判定报告 | 无 `docs/feature-maturity.zh-CN.md` | 需要新增 |
| 机器可读成熟度配置 | 无公开 registry | 无 `configs/feature-maturity.json` | 需要新增 |
| stable 核心链路 | 基本完整 | 大部分已存在 | 主要补文档和验收门禁 |
| beta 能力 | 更完整 | 已有自动审批、自动更新、对话监听等 | 缺部分反馈、评估、候选模块 |
| experimental 能力 | 更完整 | 部分图谱/治理存在 | 缺 evolve、topic、stale fact、context hygiene 等 |
| dangerous 能力 | 更完整 | 已有部分高风险脚本 | 需要先补成熟度警告和 dry-run 保护说明 |

`memory-xx` 当前缺失的脚本 key：

| 缺失脚本 | 成熟度 | 处理建议 |
|---|---|---|
| `memory:adaptive-retrieval-apply` | `dangerous`（高风险） | 最后迁移；必须默认 dry-run，`--apply` 需要显式警告 |
| `memory:adaptive-retrieval-calibration` | `experimental`（实验） | 先迁移报告/校准能力，不开放自动应用 |
| `memory:consolidation-candidates` | `beta`（测试） | 可较早补齐，只生成候选 |
| `memory:evolve` | `experimental`（实验） | 迁移为综合报告，不允许默认 apply |
| `memory:extraction-recall-eval` | `beta`（测试） | 可补齐评估能力 |
| `memory:graph-relation-repair-apply` | `dangerous`（高风险） | 最后迁移；必须要求 plan file、dry-run 和审计记录 |
| `memory:human-review-apply` | `beta`（测试） | 可补齐人工审批辅助应用 |
| `memory:observation-reflection` | `experimental`（实验） | 迁移为建议生成能力 |
| `memory:procedural-promotion-candidates` | `experimental`（实验） | 迁移为候选生成能力 |
| `memory:recall-quality-feedback` | `beta`（测试） | 可补齐反馈闭环 |
| `memory:stale-fact-report` | `experimental`（实验） | 迁移为只读报告 |

关键术语：

- `metadata`（元数据：附加在记忆、事件、策略或关系上的结构化信息，用于记录来源、分类、策略、证据和审计状态）。
- `recall_policy`（召回策略：决定一条记忆是否进入默认召回、仅显式召回、仅测试、仅审计或永不召回）。
- `scope_id`（作用域标识：配合 `scope_type` 标识记忆属于哪个用户、项目、工作区或全局空间）。
- `policy_action`（策略动作：治理策略建议或执行的动作，例如创建候选、批准、拒绝、归档或仅记录事件）。
- `dry-run`（试运行：只生成计划或报告，不修改真实数据库、向量库或运行策略）。
- `apply`（执行应用：把计划真实写入数据库、向量库或运行策略，属于高风险动作）。

## Phase 1：先补公开成熟度边界

目标：让 `memory-xx` 在开源形态下先具备“哪些功能能用、哪些功能谨慎用、哪些功能不要默认开”的清晰边界。

- [ ] 新增 `configs/feature-maturity.json`。
  - 必须包含字段：`id`、`name`、`maturity`、`surface`、`default_mode`、`requires_apply`、`risk`、`evidence`、`public_warning`。
  - `maturity` 只能取 `stable`、`beta`、`experimental`、`dangerous`。
  - `dangerous` 功能必须设置 `requires_apply=true` 或说明等价高风险触发条件。
  - `public_warning` 必须使用公开措辞，不包含私有路径或个人数据。

- [ ] 新增 `docs/feature-maturity.zh-CN.md`。
  - 按成熟度分组列出功能。
  - 从 README 当前“成熟度”表升级为完整版本。
  - 明确自动审批整体是 `beta`，global 自动审批是 `dangerous`。
  - 明确自动更新 dry-run/explain 是 `beta`，apply/rollback 是 `dangerous`。
  - 明确 evolve、topic、stale fact、context hygiene 等是 `experimental`。

- [ ] 更新 `README.md` 文档导航。
  - 增加 `docs/feature-maturity.zh-CN.md`。
  - 保留旧 alpha 风险定位。（历史计划项；当前已由 2026-06-13 release readiness 证据取代为 public preview release candidate。）
  - 不把所有能力宣传为 stable。

- [ ] 更新 `docs/features.zh-CN.md`。
  - 删除或修正当前过宽的成熟度表达。
  - 增加“详细成熟度以 feature maturity 文档为准”。
  - 把 `Auto update / supersede apply` 从单纯 experimental 拆为：dry-run/explain 为 beta，apply/rollback 为 dangerous。

- [ ] 增加成熟度配置测试。
  - 新增或扩展 `tests/open-source-readiness.test.ts`。
  - 检查 `configs/feature-maturity.json` 存在。
  - 检查所有 maturity 值合法。
  - 检查所有 `dangerous` 项有 `public_warning`。
  - 检查文档和配置不包含私有路径、真实 token、个人 scope。

验收命令：

```bash
TMPDIR=/tmp npm run typecheck
TMPDIR=/tmp node --import tsx --test tests/open-source-readiness.test.ts
TMPDIR=/tmp npm run check:secrets
```

## Phase 2：补齐 beta 能力

目标：优先补可以改善使用体验、但不会默认批量改真实数据的能力。

- [ ] 迁移 `recall-quality-feedback`（召回质量反馈）。
  - 源模块参考：`app/governance/recall-quality-feedback.ts`。
  - 目标文件：`app/governance/recall-quality-feedback.ts`、`scripts/memory-recall-quality-feedback.ts`、`tests/recall-quality-feedback.test.ts`。
  - 成熟度：`beta`。
  - 默认行为：记录/分析反馈，不直接修改召回策略。
  - 文档要求：说明 feedback（反馈：用户或 Agent 对召回结果是否有用的记录）只是证据，不是自动策略开关。

- [ ] 迁移 `extraction-recall-eval`（抽取-召回评估）。
  - 源模块参考：`app/governance/extraction-recall-eval.ts`。
  - 目标文件：`app/governance/extraction-recall-eval.ts`、`scripts/memory-extraction-recall-eval.ts`、`tests/extraction-recall-eval.test.ts`。
  - 成熟度：`beta`。
  - 默认行为：生成评估报告，不自动审批候选。

- [ ] 迁移 `consolidation-candidates`（合并候选）。
  - 源模块参考：`app/governance/consolidation-candidates.ts`。
  - 目标文件：`app/governance/consolidation-candidates.ts`、`scripts/memory-consolidation-candidates.ts`、`tests/consolidation-candidates.test.ts`。
  - 成熟度：`beta`。
  - 默认行为：只生成候选；真实 consolidate apply 仍按 `dangerous`。

- [ ] 迁移 `human-review-apply`（人工审批应用辅助）。
  - 源模块参考：`app/governance/human-review-apply.ts`。
  - 目标文件：`app/governance/human-review-apply.ts`、`scripts/memory-human-review-apply.ts`、`tests/human-review-apply.test.ts`。
  - 成熟度：`beta`。
  - 默认行为：辅助人工执行明确审批动作，不做无人值守批量批准。

- [ ] 迁移 `context-bundle`（上下文包）。
  - 源模块参考：`app/recall/context-bundle.ts`。
  - 目标文件：`app/recall/context-bundle.ts`、`tests/recall-context-bundle.test.ts`。
  - 成熟度：`beta`。
  - 默认行为：组织召回上下文，不改变记忆状态。

验收命令：

```bash
TMPDIR=/tmp npm run typecheck
TMPDIR=/tmp node --import tsx --test \
  tests/recall-quality-feedback.test.ts \
  tests/extraction-recall-eval.test.ts \
  tests/consolidation-candidates.test.ts \
  tests/human-review-apply.test.ts \
  tests/recall-context-bundle.test.ts
```

## Phase 3：补齐 experimental 报告与候选能力

目标：补齐 `memory-v2` 中有价值但不应作为默认稳定功能公开的治理观察能力。

- [ ] 迁移 `memory:evolve`（记忆演化报告）。
  - 目标文件：`app/governance/memory-evolve-report.ts`、`app/governance/memory-evolve-observation-reflection.ts`、`app/governance/memory-evolve-runtime-controls.ts`、`scripts/memory-evolve.ts`。
  - 测试：`tests/memory-evolve-report.test.ts`、`tests/memory-evolve-observation-reflection.test.ts`、`tests/memory-evolve-runtime-controls.test.ts`。
  - 成熟度：`experimental`。
  - 必须保证 `report_only=true` 或等价只读默认。

- [ ] 迁移 `observation-reflection`（观察反思）。
  - 目标文件：`app/governance/observer-reflector-governor.ts`、`scripts/memory-observation-reflection.ts`。
  - 测试：`tests/observer-reflector-governor.test.ts`。
  - 成熟度：`experimental`。
  - 默认行为：生成建议，不自动审批、不自动写策略。

- [ ] 迁移 `adaptive-retrieval-calibration`（自适应召回校准）。
  - 目标文件：`app/governance/adaptive-retrieval-calibration.ts`、`scripts/memory-adaptive-retrieval-calibration.ts`。
  - 测试：`tests/adaptive-retrieval-calibration.test.ts`。
  - 成熟度：`experimental`。
  - 默认行为：只生成 threshold（阈值）建议。

- [ ] 迁移 topic 与 stale fact 报告。
  - 目标文件：`app/governance/topic-alias-candidates.ts`、`app/governance/topic-normalization-plan.ts`、`app/governance/stale-fact-report.ts`、`scripts/memory-stale-fact-report.ts`。
  - 测试：`tests/topic-alias-candidates.test.ts`、`tests/topic-normalization-plan.test.ts`、`tests/stale-fact-report.test.ts`。
  - 成熟度：`experimental`。

- [ ] 迁移 context hygiene 与 pending evidence 报告。
  - 目标文件：`app/governance/context-hygiene-report.ts`、`app/governance/pending-approval-evidence-report.ts`。
  - 测试：`tests/context-hygiene-report.test.ts`、`tests/pending-approval-evidence-report.test.ts`。
  - 成熟度：`experimental`。

- [ ] 迁移 procedural promotion 与 memory link candidates。
  - 目标文件：`app/governance/procedural-promotion-candidates.ts`、`app/governance/memory-link-candidates.ts`。
  - 测试：`tests/procedural-promotion-candidates.test.ts`、`tests/memory-link-candidates.test.ts`。
  - 成熟度：`experimental`。

验收命令：

```bash
TMPDIR=/tmp npm run typecheck
TMPDIR=/tmp node --import tsx --test \
  tests/memory-evolve-report.test.ts \
  tests/memory-evolve-observation-reflection.test.ts \
  tests/memory-evolve-runtime-controls.test.ts \
  tests/observer-reflector-governor.test.ts \
  tests/adaptive-retrieval-calibration.test.ts \
  tests/topic-alias-candidates.test.ts \
  tests/topic-normalization-plan.test.ts \
  tests/stale-fact-report.test.ts \
  tests/context-hygiene-report.test.ts \
  tests/pending-approval-evidence-report.test.ts \
  tests/procedural-promotion-candidates.test.ts \
  tests/memory-link-candidates.test.ts
```

## Phase 4：补齐图谱治理能力

目标：把 `memory-v2` 更完整的图谱治理迁移到 `memory-xx`，但保持 report/plan 与 apply 分离。

- [ ] 迁移 relation vocabulary（关系词表）。
  - 目标文件：`app/shared/memory-relation-types.ts`。
  - 测试：`tests/memory-relation-vocabulary.test.ts`。
  - 成熟度：`stable` 到 `beta`，仅限类型/词表本身。

- [ ] 迁移 graph repair plan（图谱关系修复计划）。
  - 目标文件：`app/governance/graph-relation-repair-plan.ts`。
  - 测试：`tests/graph-relation-repair-plan.test.ts`。
  - 成熟度：`experimental`。
  - 默认行为：只生成 repair plan（修复计划），不修改关系。

- [ ] 迁移 graph successor discovery（图谱后继发现）。
  - 目标文件：`app/governance/graph-successor-discovery-candidates.ts`。
  - 测试：`tests/graph-successor-discovery-candidates.test.ts`。
  - 成熟度：`experimental`。

- [ ] 迁移 graph debt / orphan / readiness 报告。
  - 目标文件：`app/governance/graph-debt-backfill-policy.ts`、`app/governance/graph-orphan-report.ts`、`app/governance/memory-os-readiness-report.ts`。
  - 测试：`tests/graph-debt-backfill-policy.test.ts`、`tests/graph-orphan-report.test.ts`、`tests/memory-os-readiness-report.test.ts`。
  - 成熟度：`experimental`。

验收命令：

```bash
TMPDIR=/tmp npm run typecheck
TMPDIR=/tmp node --import tsx --test \
  tests/memory-relation-vocabulary.test.ts \
  tests/graph-relation-repair-plan.test.ts \
  tests/graph-successor-discovery-candidates.test.ts \
  tests/graph-debt-backfill-policy.test.ts \
  tests/graph-orphan-report.test.ts \
  tests/memory-os-readiness-report.test.ts
```

## Phase 5：最后处理 dangerous apply 能力

目标：只在文档、配置、测试和 dry-run 边界全部完成后，再补高风险执行能力。

- [ ] 迁移 `adaptive-retrieval-apply`。
  - 目标文件：`app/governance/adaptive-retrieval-apply.ts`、`scripts/memory-adaptive-retrieval-apply.ts`。
  - 测试：`tests/adaptive-retrieval-apply.test.ts`、`tests/adaptive-retrieval-apply-script.test.ts`。
  - 成熟度：`dangerous`。
  - 必须要求 plan file 或明确 plan 输入。
  - 默认 dry-run；`--apply` 必须写入 governance action（治理动作审计）。
  - 禁止对 explicit memory lookup（显式记忆 ID 查询）选择器应用阈值覆盖。

- [ ] 迁移 `graph-relation-repair-apply`。
  - 目标文件：`app/governance/graph-relation-repair-executor.ts`、`scripts/memory-graph-relation-repair-apply.ts`。
  - 测试：`tests/graph-relation-repair-executor.test.ts`、`tests/graph-relation-repair-apply-script.test.ts`。
  - 成熟度：`dangerous`。
  - 必须要求 plan file。
  - 默认 dry-run；`--apply` 只能执行 `apply_allowed=true` 的 guarded plan（受保护计划）。

- [ ] 更新 `configs/feature-maturity.json`。
  - 为上述两个功能设置 `maturity=dangerous`。
  - 设置 `requires_apply=true`。
  - `public_warning` 必须包含“测试阶段，请谨慎使用；先 dry-run，再 apply”。

- [ ] 更新 `docs/feature-maturity.zh-CN.md`。
  - 把这两个功能放入 `dangerous` 表。
  - 明确它们不是默认生产能力。

验收命令：

```bash
TMPDIR=/tmp npm run typecheck
TMPDIR=/tmp node --import tsx --test \
  tests/adaptive-retrieval-apply.test.ts \
  tests/adaptive-retrieval-apply-script.test.ts \
  tests/graph-relation-repair-executor.test.ts \
  tests/graph-relation-repair-apply-script.test.ts \
  tests/governance-execution-boundary.test.ts
TMPDIR=/tmp npm run check:secrets
```

## Phase 6：最终开源验收

目标：确认 `memory-xx` 对外呈现的是可解释、可治理、风险分级明确的开源版本。

- [ ] 所有 `memory:*` 脚本都能在 `configs/feature-maturity.json` 中找到所属能力组，或明确标记为 internal（内部：不作为公开用户入口）。
- [ ] README 不再只写笼统成熟度，必须链接到 `docs/feature-maturity.zh-CN.md`。
- [ ] `docs/features.zh-CN.md`、`docs/policy-governance.zh-CN.md`、`docs/canary.zh-CN.md` 中所有自动审批/自动更新描述与成熟度字段一致。
- [ ] `dangerous` 功能全部有 dry-run 示例和 apply 警告。
- [ ] `experimental` 功能全部写明“报告/候选/观察为主，不建议生产自动化依赖”。
- [ ] `stable` 功能不得依赖私有路径或个人运行环境。
- [ ] 运行开源检查：

```bash
TMPDIR=/tmp npm run typecheck
TMPDIR=/tmp npm test
TMPDIR=/tmp npm run verify:open-source
TMPDIR=/tmp npm run check:secrets
TMPDIR=/tmp npm run memory:deployment-bundle -- --dry-run --json
```

## 推荐执行顺序

1. Phase 1：成熟度 registry（注册表：机器可读能力清单）和公开文档。
2. Phase 2：beta 反馈/评估/候选能力。
3. Phase 3：experimental 报告/观察能力。
4. Phase 4：图谱治理 plan/report。
5. Phase 5：dangerous apply 能力。
6. Phase 6：开源验收。

这个顺序的理由是：先让公开边界正确，再补功能。否则 `memory-xx` 很容易出现“功能已经搬过去，但用户不知道哪些能安全用”的问题。
