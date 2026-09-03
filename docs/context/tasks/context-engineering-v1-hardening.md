---
id: context-engineering-v1-hardening-task
type: task
scope: 补齐 mono2 Context Engineering V1 的项目级、任务级、设计历史和 docs-impact 治理缺口。
triggers: ["context engineering hardening", "design history", "docs impact", "上下文工程补强"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/context-engineering-v1-hardening.md
  - docs/engineering/decisions/ADR-0002-design-history-and-docs-impact.md
  - .agents/context/design-history-index.json
status: active
reviewed_at: 2026-09-01
review_due: 2026-09-08
revision: 1.0.0
precedence: task
derived: false
---

# Task Pack：Context Engineering V1 补强

## goal

在不增加默认 Context 注入的前提下，补齐 mono2 项目级短 Context、任务级需求/接口/历史字段、五态生命周期、设计历史索引和 docs-impact 变更治理，并用正反例验证。

## non_goals

- 不对全仓历史需求做无来源的批量回填；外部 MR/TAPD/Issue 未访问时保留未知。
- 不修改运行时代码、生产、GitOps、外部服务，也不安装用户机器的 Git Hook。
- 不把模型输出、评分、报告、回执或凭据写入运行时 Context 或 Git。

## requirement_ids / requirement_refs / requirement_excerpt

- `context-engineering-v1-hardening`
- [设计历史与 docs-impact ADR](../../engineering/decisions/ADR-0002-design-history-and-docs-impact.md)

需求摘要：让后续 Agent 先定位当前设计和受影响历史，而不是全仓扫描；让受影响代码与至少一份对应正式设计文档在同一变更中演进。

## interface_refs / data_structure_refs

- `.agents/context/context-routing.yaml`：按需加载与禁入边界。
- `.agents/context/context-pack.schema.json`：Context 元数据与生命周期枚举。
- `.agents/context/design-history-index.json`：功能族、来源状态、当前设计与未知项。
- `.agents/context/change-impact.json`：路径到正式设计文档的映射。

## history_context

- `current_design_refs`：[ADR 0001](../decisions/ADR-0001-context-engineering-v2.md)、[ADR 0002](../../engineering/decisions/ADR-0002-design-history-and-docs-impact.md)、[文档治理策略](../../engineering/governance/documentation-policy.md)。
- `relevant_evolution`：旧 V2 Pack 保留初建时的静态基线；本轮通过当前文件与本地 Git 可读证据补齐治理，不把未提交内容冒充 Git 历史。
- `superseded_refs`：旧 Pack 已标为 `stale`，只在需要解释迁移来源时读取。

## affected_paths

- `AGENTS.md`、`docs/context/`、`docs/engineering/`
- `.agents/context/`、`.pre-commit-config.yaml`、`.ci/guards.manifest`

## required_context

- `context-governance`
- `project-overview`（仅在系统边界或跨服务决策时）

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | P0 与路由合同 | 确认不扩张默认读取，也不执行外部写入 |
| `docs/context/23-rules-matrix.md@working-tree` | 23 条规则当前落点 | 保持“实现事实”和成熟度分离 |
| `docs/context/decisions/ADR-0001-context-engineering-v2.md@working-tree` | 初建的路由决策 | 只补治理缺口，不重写架构方向 |
| `.agents/context/context-routing.yaml@working-tree` | 现有精确/符号/关键词路由 | 新项目级卡只按需命中 |
| `.agents/context/scripts/validate_context.py@working-tree` | 现有结构校验 | 增加治理资产的可执行正反例 |
| `.ci/runtime/guards/changed_guards.py@working-tree` | MR guard 派发方式 | 将 docs-impact 接入已有显式 guard 机制 |

## acceptance

- 项目级短 Context 回链架构、模块关系、数据模型、关键流程、易错点与当前 ADR，且不进入无关任务的 `must_read`。
- Task Pack 模板与一个 active Pack 都具备需求、接口、数据结构、当前设计、历史回退和 receipt 字段。
- 生命周期为 `candidate/pilot/active/stale/retired`；设计历史索引明确当前、未知和回退边界。
- 命中核心代码路径但没有同步设计文档时 docs-impact 失败；同一变更含匹配正式设计文档时通过。
- Context Validator、Documentation Validator、Context/Audit 单测、docs-impact 正反例和 `git diff --check` 通过。

## evidence

- 本轮前已有 23 服务四件套、5 个 Domain、5 条 Journey、39 个路由 smoke case 和评测隔离；但项目级短 Context、历史恢复索引、五态生命周期和路径到设计的持续治理未闭环。
- 历史来源的外部 MR/TAPD/Issue 访问状态以 `unknown` 记录，不将它们写作已经检索或恢复完成。

## risks

- 路径映射只能提醒相关设计文档更新，不能判断解释是否正确。缓解：Agent 先做语义评审，Owner 在受保护 MR 平台完成审批。
- 对每次服务改动都强制长文重写会制造噪声。缓解：规则只要求至少一个匹配的正式设计真源同变更出现，正文应更新受影响事实而非复制内容。

## validation

```bash
python3 .agents/context/scripts/validate_change_impact.py --repo . --changed-file user/auth/internal/session/service.go
python3 .agents/context/scripts/validate_change_impact.py --repo . --changed-file user/auth/internal/session/service.go --changed-file docs/engineering/domains/identity-access.md
python3 .agents/context/scripts/validate_context.py --repo . --build-catalog
python3 .agents/context/scripts/validate_documentation.py --repo . --format json
python3 -m unittest discover -s .agents/context/tests -v
```

## decisions

- 以职责、真源、路由和维护闭环为完成条件，而不是目录或文件数量。
- 历史检索按任务做有界恢复；项目级卡只保存当前入口和不可违背的边界。
- docs-impact 是确定性同步门禁，Agent 与 Owner 仍负责语义判断和最终验收。

## scan_scope / scan_output

- 扫描 `.agents/context/`、`docs/context/`、`docs/engineering/` 和 CI guard 配置。
- 只保留 Validator JSON 摘要、失败路径和可定位来源；不内联全仓扫描或评测结果。

## handoff

- 当前建设完成后，Owner 可审阅变更；提交、MR、平台级审批和发布需要另行授权。
