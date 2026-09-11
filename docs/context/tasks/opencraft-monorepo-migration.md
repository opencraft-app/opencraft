---
id: task-opencraft-monorepo-migration-2026-09-10
type: task
scope: 以保留历史的一次性 subtree 将 OpenCraft 迁入 mono2，并建立唯一真源、Catalog 与共享前端边界。
triggers: ["opencraft migration", "opencraft subtree", "monorepo migration"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/opencraft-monorepo-migration.md
  - opencraft/MONO2_MIGRATION.md
status: active
reviewed_at: 2026-09-11
review_due: 2026-12-09
revision: 1.1.0
precedence: task
derived: false
---

## goal

将 OpenCraft 工作台仓库以保留历史的一次性 subtree 导入 `mono2/opencraft/`，并使 mono2 成为后续唯一代码真源；建立独立的服务目录和与 `frontend/` 的显式共享边界。

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
- `docs/engineering/catalog/services.yaml` 与 `opencraft/catalog-info.yaml`：服务登记真源。
- 不变量：OpenCraft 不注册 mono2 MR 占位检查或专用 CI 流水线；共享源码只能由显式脚本或后续 workspace 包边界消费，本地完整验证仍由 `npm run gate` 提供。

## history_context

- `current_design_refs`：`docs/context/project/upstream-subtrees.md@2.0.0`、`docs/engineering/catalog/services.yaml@7f636c34d`、`velalink/MONO2_SUBTREE.md@7f636c34d`。
- `relevant_evolution`：OpenCraft 独立仓库迁移源为 `/vela` 分支 `codex/mono2-migration-source`，初始快照 `af7e7d0`、登录增量 `c3daab3`、运行时增量 `a3e981f`、Host Catalog 恢复最终快照 `4b0d4e6`；mono2 初始导入基线 `7f636c34d`，同步时刷新至 `a8d70ca37`。
- `superseded_refs`：OpenCraft 旧仓库在迁移完成后仅作为只读历史与回退源，不再接受双向同步。

## acceptance

- `git log -- opencraft` 能追溯 OpenCraft 原仓库历史，导入不得 squash。
- `opencraft/` 在 mono2 中保持独立 npm workspace 根；不注册 MR guard 或专用 CI 路径触发器。
- OpenCraft 的 mono2 同步脚本默认从 `../frontend/src` 解析，生成清单不包含 worktree 绝对路径。
- Catalog、OWNERS/AGENTS 边界和迁移谱系说明齐全。
- `cd opencraft && npm ci && npm run check:mono2-agent-console && npm run gate` 通过，或对环境型失败给出可复现证据且所有受影响聚焦门禁通过。
- mono2 context/change-impact guard 通过。

## affected_paths

- `opencraft/**`
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
| `.ci/AGENTS.md@2026-09-11` | CI 运行时修改与验证约束 | 要求删除注册后运行 CI runtime 契约测试 |
| `.ci/guards.manifest@2026-09-11` | MR 占位检查注册真源 | 定位并删除 `opencraft` guard |
| `opencraft/checks/guard.sh@2026-09-11` | OpenCraft 隔离门禁实现 | 确认 Node/npm warning 来自隔离 `npm ci`，并删除该入口 |

## evidence

- `/vela` 迁移源提交前：315 个索引文件凭据扫描零命中、无大于 5 MiB 单文件。
- `/vela`：边界与全 workspace 类型检查通过；扩展 111/111、Chat 358/358、Workbench 186/186、Web 发布 5/5 通过；Web、Expo Web、Expo iOS 构建通过。
- `/vela` 初始迁移源提交为 `af7e7d04b271d788c8177aad411675dbe29f7172`；验证期间新增的统一 OIDC/PKCE 登录实现提交为 `c3daab35df63fb3e083792cbbab4930cd4922f3c`，源分支保持干净。
- mono2 基线 `7f636c34d155f31bdfc6df4c7d83a3d36c5d11d3`；Task Pack 提交 `06f04e2d2`；non-squash subtree 导入提交 `327368646e4e4dda2505caa108736f2d2a58cdb6`，提交包含 `git-subtree-split: af7e7d04...`；迁移窗口尾部同步提交为 `5865a68a9796d5af2fcd61392bcb12d9a3934da8`，第二父提交为 `c3daab3...`。
- 用户再次请求同步后，源仓库的 Hermes 恢复/工具语义、跨平台消息折叠与原生 polyfill 增量提交为 `a3e981f543d3662616a72930d12c52cbaa9adccd`；mono2 先通过 `70d009c3e` 合并最新 `origin/master@a8d70ca37`，再通过 `84625b756` non-squash subtree pull 保留该源提交为第二父历史。
- 最新 mono2 `frontend/` 共享闭包已重新生成并验证 125 个文件，清单来源仍为 `frontend/src`，`sourceRevision` 为 `4126d39cd43258321df3991b81d4cecff2156971`。
- Host 恢复后 Catalog 自动恢复增量来自上游 `7ff9f46a`，合并后的源快照为 `4b0d4e6b`；mono2 通过 `36a3eb001` non-squash subtree pull 保留完整第二父历史。
- `npm ci` 从空依赖目录成功安装 1,326 个包；`npm audit --omit=dev --audit-level=high` 无 high/critical，报告 13 个需要破坏性 Expo 降级/变更才能自动修复的 moderate 间接依赖问题，本轮未执行 `--force`。
- `npm run check:mono2-agent-console` 验证 125 个共享前端文件；清单来源为 `frontend/src`，不含 worktree 绝对路径。
- `npm run gate` 通过：边界、全 workspace 类型检查、扩展/AppServer/AppServer Lab/Chat/Workbench/Web release 测试以及 Web、Expo Web、Expo iOS 构建全部完成。
- 迁移窗口尾部登录增量：账户认证聚焦测试 10/10 通过，Hermes 插件、Workbench Web 与 Expo 类型检查通过。
- 最新运行时增量：8 个受影响测试文件共 177/177 通过，全 workspace TypeScript 检查通过。
- Host Catalog 恢复增量：Catalog readiness、BFCache 页面生命周期与账户认证聚焦测试共 14/14 通过，Workbench Web 类型检查通过。
- 文档系统 8/8 单测、Service Catalog 25/25 覆盖、42 个路由 smoke case、docs-impact 和 CI runtime 501 个测试通过。
- 全仓 Context Validator 的既有失败从 `origin/master` 的 387 条变为当前 386 条（重建 catalog 后消除 stale 提示）；剩余为 master 已存在的旧 Task Pack metadata 和 5 个历史文档明文扫描命中，本迁移没有新增失败。
- 2026-09-11 按 owner 决策移除 `.ci/guards.manifest` 的 `opencraft` MR guard、`.ci/opencraft.yml` 专用流水线和 `opencraft/checks/guard.sh` 隔离安装脚本；OpenCraft 本地 `npm run gate` 保留。
- `bash .ci/runtime/check_ci_runtime.sh` 在补充临时 Git 测试身份后通过，503 个 runtime 契约测试全部成功；原始运行的 5 个错误仅由机器未配置 Git 提交身份导致。
- 使用用户报告中的两个 `frontend/src/pages/marketing/**` 文件 dry-run guard 派发，仅命中 `frontend`，不再命中 `opencraft`。

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
- `bash .ci/runtime/check_ci_runtime.sh`
- 检查 `.ci/guards.manifest` 不再注册 `opencraft`，且不存在 `.ci/opencraft.yml` 与 `opencraft/checks/guard.sh`。

## decisions

- 使用 non-squash `git subtree add` 导入完整历史，并仅在迁移验证窗口内执行一次 non-squash `git subtree pull` 捕获并发落下的登录增量；合入后不建立持续同步，owner：本迁移任务。
- mono2 在导入后成为唯一写入真源；不建立长期 `subtree pull/split` 双向工作流，owner：本迁移任务。
- 目标目录为 `opencraft/`，不放入 `frontend/`；前者同时包含 Web、Expo、Electron、AppServer、packages 和 plugins，owner：本迁移任务。
- OpenCraft 不设置 mono2 MR guard 或专用 CI 流水线；完整 gate 保留为本地/按需验证能力，且不授权生产发布，owner：本迁移任务。

## scan_scope

- `opencraft/**`
- `.ci/guards.manifest`
- `docs/engineering/catalog/services.yaml`

## scan_output

- 凭据扫描与大文件摘要记录在 `evidence`；不内联任何凭据内容。

## handoff

- 当前状态：OpenCraft 已保留历史导入 mono2，治理和相对共享路径均已完成；专用 CI 栅栏已按 owner 决策撤销，本地完整门禁保留。
- 下一步：获得用户明确授权后推送分支并创建 MR。迁移合入后将旧仓库切换为只读并在另一次确认后归档。
- 阻塞项：推送、MR 和任何发布尚未获得本轮明确授权；本地迁移不受阻。
