---
id: task-opencraft-monorepo-migration-2026-09-10
type: task
scope: 以保留历史的一次性 subtree 将 OpenCraft 迁入 mono2，并建立唯一真源、CI、Catalog 与共享前端边界。
triggers: ["opencraft migration", "opencraft subtree", "monorepo migration"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/opencraft-monorepo-migration.md
  - opencraft/MONO2_MIGRATION.md
status: active
reviewed_at: 2026-09-10
review_due: 2026-12-09
revision: 1.0.0
precedence: task
derived: false
---

## goal

将 OpenCraft 工作台仓库以保留历史的一次性 subtree 导入 `mono2/opencraft/`，并使 mono2 成为后续唯一代码真源；建立独立的服务目录、CI 边界和与 `frontend/` 的显式共享边界。

## non_goals

- 本轮不发布 OpenCraft，也不修改生产 GitOps 配置。
- 本轮不删除或归档旧的 `wisp/opencraft` 远端仓库。
- 本轮不立即完成所有 `frontend/` 共享组件的包级提取；先消除绝对路径并记录后续拆分边界。
- 不将 OpenCraft 混入 `frontend/` 的构建、发布或运行时所有权。

## requirement_ids / requirement_refs / requirement_excerpt

- `user-2026-09-10-opencraft-migration`：当前 OpenCraft 已有大量更新，先完整提交，再开始迁入 mono2；最大限度复用 mono2 `frontend/` 代码，旧独立仓库不再作为长期真源。
- 外部 Issue / MR：`unknown`。

## interface_refs / data_structure_refs

- `opencraft/package.json`：OpenCraft npm workspace 与本地门禁入口。
- `opencraft/scripts/sync-mono2-agent-console.mjs`：当前 `frontend/` Agent Console 依赖闭包；迁入后必须使用 monorepo 相对路径，禁止机器绝对路径成为接口。
- `frontend/src/pages/marketing/**`：当前被 OpenCraft 消费的 Agent Console 上游实现。
- `.ci/opencraft.yml`：OpenCraft 独立 CI 所有权；不得触发 frontend 发布。
- `docs/engineering/catalog/services.yaml` 与 `opencraft/catalog-info.yaml`：服务登记真源。
- 不变量：OpenCraft 构建失败不得触发 `frontend`、GitOps 或生产发布；共享源码只能由显式脚本或后续 workspace 包边界消费。

## history_context

- `current_design_refs`：`docs/context/project/upstream-subtrees.md@2.0.0`、`docs/engineering/catalog/services.yaml@7f636c34d`、`velalink/MONO2_SUBTREE.md@7f636c34d`。
- `relevant_evolution`：OpenCraft 独立仓库迁移源为 `/vela` 分支 `codex/mono2-migration-source` commit `af7e7d0`；mono2 导入基线为 `origin/master` commit `7f636c34d`。
- `superseded_refs`：OpenCraft 旧仓库在迁移完成后仅作为只读历史与回退源，不再接受双向同步。

## acceptance

- `git log -- opencraft` 能追溯 OpenCraft 原仓库历史，导入不得 squash。
- `opencraft/` 在 mono2 中保持独立 npm workspace 根和独立 CI 路径触发器。
- OpenCraft 的 mono2 同步脚本默认从 `../frontend/src` 解析，生成清单不包含 worktree 绝对路径。
- Catalog、OWNERS/AGENTS 边界和迁移谱系说明齐全。
- `cd opencraft && npm ci && npm run check:mono2-agent-console && npm run gate` 通过，或对环境型失败给出可复现证据且所有受影响聚焦门禁通过。
- mono2 context/change-impact guard 通过。

## affected_paths

- `opencraft/**`
- `.ci/opencraft.yml`
- `.ci/guards.manifest`
- `docs/engineering/catalog/services.yaml`
- `docs/context/tasks/opencraft-monorepo-migration.md`

## required_context

- Pack ID `upstream-subtrees`。
- `docs/context/project/upstream-subtrees.md`。
- `velalink/MONO2_SUBTREE.md` 作为现有保留谱系实现参考。
- `AGENTS.md` 与 `.ci/AGENTS.md`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@7f636c34d` | mono2 全局交付与 Task Pack 约束 | 决定使用隔离 worktree、先建 Pack、验证后提交 |
| `docs/context/project/upstream-subtrees.md@2.0.0` | subtree 权威边界 | 禁止复制或 squash 历史，要求记录 commit 与命令 |
| `velalink/MONO2_SUBTREE.md@7f636c34d` | 现有 subtree 谱系模板 | 设计 OpenCraft 一次性导入的 provenance 记录 |
| `.ci/frontend.yml@7f636c34d` | frontend CI 与发布所有权 | 保证 OpenCraft 路径不误触发 frontend 发布 |
| `docs/engineering/catalog/services.yaml@7f636c34d` | 服务目录真源 | 新增独立 `opencraft` 服务登记 |
| `/vela/package.json@af7e7d0` | OpenCraft 构建与门禁入口 | 定义迁移后 CI 命令和工作目录 |

## evidence

- `/vela` 迁移源提交前：315 个索引文件凭据扫描零命中、无大于 5 MiB 单文件。
- `/vela`：边界与全 workspace 类型检查通过；扩展 111/111、Chat 358/358、Workbench 186/186、Web 发布 5/5 通过；Web、Expo Web、Expo iOS 构建通过。
- `/vela` 迁移源已提交为 `af7e7d04b271d788c8177aad411675dbe29f7172`，分支 `codex/mono2-migration-source` 保持干净且未推送。
- mono2 基线 `7f636c34d155f31bdfc6df4c7d83a3d36c5d11d3`；Task Pack 提交 `06f04e2d2`；non-squash subtree 导入提交 `327368646e4e4dda2505caa108736f2d2a58cdb6`，提交包含 `git-subtree-split: af7e7d04...`。
- `npm ci` 从空依赖目录成功安装 1,326 个包；`npm audit --omit=dev --audit-level=high` 无 high/critical，报告 13 个需要破坏性 Expo 降级/变更才能自动修复的 moderate 间接依赖问题，本轮未执行 `--force`。
- `npm run check:mono2-agent-console` 验证 125 个共享前端文件；清单来源为 `frontend/src`，不含 worktree 绝对路径。
- `npm run gate` 通过：边界、全 workspace 类型检查、扩展/AppServer/AppServer Lab/Chat/Workbench/Web release 测试以及 Web、Expo Web、Expo iOS 构建全部完成。
- 文档系统 8/8 单测、Service Catalog 25/25 覆盖、42 个路由 smoke case、docs-impact 和 CI runtime 501 个测试通过。
- 全仓 Context Validator 的既有失败从 `origin/master` 的 387 条变为当前 386 条（重建 catalog 后消除 stale 提示）；剩余为 master 已存在的旧 Task Pack metadata 和 5 个历史文档明文扫描命中，本迁移没有新增失败。

## risks

- Vendored Agent Console 的文本重写会随 `frontend/` 演进漂移；本轮先改为仓库相对解析并保留 drift gate，后续提取稳定 workspace 包以删除 vendoring。
- subtree 导入会显著增加 mono2 历史和 checkout 文件数；使用一次性 non-squash 导入，之后不维持双源同步。
- OpenCraft npm 与 mono2 frontend pnpm 的包管理器不同；两者保持服务级独立锁文件，禁止合并锁文件或提升依赖到 mono2 根。
- 回滚：在 MR 合入前删除迁移分支；合入后使用 revert 提交，不重写 mono2 master 历史。

## validation

- `python3 .agents/context/scripts/validate_context.py --route "..."`
- `python3 .agents/context/scripts/validate_context.py --changed-files ...`
- `cd opencraft && npm ci`
- `cd opencraft && npm run check:mono2-agent-console`
- `cd opencraft && npm run gate`
- 检查 `.ci/opencraft.yml` 仅包含 `opencraft/**` 及明确共享路径。

## decisions

- 使用 `git subtree add --prefix=opencraft /vela codex/mono2-migration-source --no-squash`，owner：本迁移任务。
- mono2 在导入后成为唯一写入真源；不建立长期 `subtree pull/split` 双向工作流，owner：本迁移任务。
- 目标目录为 `opencraft/`，不放入 `frontend/`；前者同时包含 Web、Expo、Electron、AppServer、packages 和 plugins，owner：本迁移任务。
- 迁移本身只建立 build/test CI，不授权生产发布，owner：本迁移任务。

## scan_scope

- `opencraft/**`
- `.ci/opencraft.yml`
- `docs/engineering/catalog/services.yaml`

## scan_output

- 凭据扫描与大文件摘要记录在 `evidence`；不内联任何凭据内容。

## handoff

- 当前状态：源仓库更新与 mono2 迁移收尾均已在本地提交；OpenCraft 已保留历史导入 mono2，治理、相对共享路径、独立验证 CI 与完整门禁均已完成。
- 下一步：获得用户明确授权后推送分支并创建 MR。迁移合入后将旧仓库切换为只读并在另一次确认后归档。
- 阻塞项：推送、MR 和任何发布尚未获得本轮明确授权；本地迁移不受阻。
