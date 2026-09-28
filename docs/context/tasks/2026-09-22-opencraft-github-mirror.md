---
id: opencraft-github-mirror
type: task
scope: Record the one-way public mirror authority between mono2/opencraft and GitHub.
triggers: ["OpenCraft GitHub mirror", "OpenCraft subtree mirror", "public mirror"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-22-opencraft-github-mirror.md
status: active
reviewed_at: 2026-09-22
review_due: 2026-12-21
revision: 1.0.0
precedence: task
derived: false
---

## goal
在 mono2 根入口与权威迁移文档中固定 OpenCraft 的单向公开镜像模式，避免 GitHub 导出被误解为第二写入源或持续上游。

## non_goals
- 不新增自动推送、CI 凭据、定时任务或双向同步。
- 不修改 Git 历史、提交代码或再次推送 GitHub。
- 不改变 NewAPI、VelaGW 或 VelaLink 的持续 subtree 契约。

## requirement_ids / requirement_refs / requirement_excerpt
- `user-2026-09-22-opencraft-one-way-mirror`：用户确认先采用 `mono2/opencraft -> github.com/opencraft-app/opencraft` 单向镜像，并要求更新 mono2 根 `AGENTS.md`。

## interface_refs / data_structure_refs
- `AGENTS.md`
- `opencraft/MONO2_MIGRATION.md`
- `docs/context/project/upstream-subtrees.md`
- `docs/context/decisions/ADR-0001-context-engineering-v2.md`
- 不变量：mono2 是唯一写入真源；GitHub 只接收审计后的 split；不反向 pull、不双写。

## history_context
- `current_design_refs`：`opencraft/MONO2_MIGRATION.md`、`docs/context/project/upstream-subtrees.md`。
- `relevant_evolution`：OpenCraft 于提交 `327368646e4e4dda2505caa108736f2d2a58cdb6` 以 `--no-squash` subtree 导入 mono2；2026-09-22 首次将当前 split 历史经邮箱重写和敏感信息扫描推送到 GitHub `main`。
- `superseded_refs`：旧 `wisp/opencraft` 只作迁移与回退证据，不承担当前镜像或开发权威。

## acceptance
- 根 `AGENTS.md` 明确唯一真源、镜像地址、禁止反向 pull/双写和显式 push 授权。
- 详细导出规则由 `opencraft/MONO2_MIGRATION.md` 唯一维护。
- Project Pack 与 Context ADR 同步反映权威层次。
- Context、文档链接、change-impact 与 whitespace 门禁通过；既有无关失败单独报告。

## affected_paths
- `AGENTS.md`
- `opencraft/MONO2_MIGRATION.md`
- `docs/context/project/upstream-subtrees.md`
- `docs/context/decisions/ADR-0001-context-engineering-v2.md`
- `docs/context/tasks/2026-09-22-opencraft-github-mirror.md`

## required_context
- `upstream-subtrees`
- 根 `AGENTS.md`
- `opencraft/AGENTS.md`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 根 Team 指令目标 | 保持入口简洁并声明 P0 push 授权 |
| `opencraft/AGENTS.md@working-tree` | OpenCraft 局部边界 | 确认 mono2 唯一真源的既有约束 |
| `docs/context/project/upstream-subtrees.md@working-tree` | Router 命中的 Project Pack | 区分持续上游与公开下游镜像 |
| `opencraft/MONO2_MIGRATION.md@working-tree` | OpenCraft 导入与所有权权威 | 承载详细镜像操作不变量 |
| `docs/context/decisions/ADR-0001-context-engineering-v2.md@working-tree` | 根入口的正式设计依据 | 记录 Team/Project 权威分层 |

## evidence
- `git ls-remote --symref git@github.com:opencraft-app/opencraft.git HEAD` 已确认远端默认分支为 `main`，首个镜像提交已存在。
- 当前根入口修改仅声明权威和路由；未执行 commit、push、MR、发布或生产操作。
- 文档链接校验、显式变更集 change-impact 与 `git diff --check` 通过；catalog 已重建并收录本 Task Pack。
- 全仓 Context Validator/测试仍被既有旧 Task Pack schema、参考仓库超长指令链/断链和既有 secret-literal 候选阻塞；失败清单未命中本 Task Pack 或本轮新增镜像内容。

## risks
- 若未来直接在 GitHub 合并代码，会形成未被 mono2 门禁验证的第二写入源；规则要求外部贡献先回到 mono2。
- 邮箱重写会改变导出 commit ID；每次必须重写完整 split 历史并验证已有远端可 fast-forward，禁止强推掩盖漂移。

## validation
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`
- `python3 .agents/context/scripts/validate_context.py --build-catalog`
- `python3 -m unittest discover -s .agents/context/tests -v`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --changed-file ...`
- `git diff --check`

## decisions
- 采用 mono2 到 GitHub 的单向人工受控镜像；暂不建立自动化或反向同步。
- 根入口只声明权威和硬边界，详细 runbook 留在 `opencraft/MONO2_MIGRATION.md`。

## scan_scope
- `AGENTS.md`
- `opencraft/MONO2_MIGRATION.md`
- `docs/context/project/upstream-subtrees.md`
- `docs/context/decisions/ADR-0001-context-engineering-v2.md`

## scan_output
- Router 命中 `upstream-subtrees`；未扩大到无关服务。

## handoff
- 单向镜像边界已写入根入口、OpenCraft 迁移权威、Project Pack 与 Context ADR；未提交或推送。
- 聚焦文档与 change-impact 门禁通过。全仓 Context catalog/测试的既有基线失败保留，未在本任务扩展修复范围。
