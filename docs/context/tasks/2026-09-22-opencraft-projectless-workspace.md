---
id: opencraft-projectless-workspace
type: task
scope: Host-owned cross-platform Projectless Workspace resolution for new OpenCraft Threads.
triggers: ["new machine thread start", "Projectless Workspace", "~/OpenCraft"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-22-opencraft-projectless-workspace.md
status: complete
reviewed_at: 2026-09-23
review_due: 2026-12-21
revision: 1.1.0
precedence: task
derived: false
---

## goal
允许没有 Project 的新机器直接提交首个任务：Local Host 在 `~/OpenCraft` 下创建 Thread 独享目录并传递确定 cwd；显式 Project 继续使用并验证用户选择的目录。

## non_goals
- 不禁用 Composer，不显示“请先选择项目文件夹”。
- 不让 Renderer 构造 macOS/Windows 用户绝对路径。
- 不修改 Remote Host 的目录规则，不安装、提交、推送或发布。

## interface_refs / data_structure_refs
- `LocalWorkspaceResolver`：Local Host 唯一 cwd/root 解析者。
- `DshAppServerAdapter.thread/start`：模型门禁后、引擎创建前消费已解析 Workspace。
- 不变量：`cwd=null` 表示 Projectless 意图，不是把缺失字段直接交给引擎猜测。

## reference_findings
- Codex 将新 Thread 目标分为 `project`、`remoteProject`、`projectless`；Projectless 先调用 Host `projectless-thread-cwd`，取得 cwd/roots 后才启动 Thread。
- WorkBuddy 的 Renderer 对 macOS/Windows 都提交 `~/WorkBuddy` 逻辑根，由 daemon 使用 `os.homedir()` 展开；已有目录通过统一 `pickFolder -> Electron Main -> native dialog` 返回绝对路径。
- OpenCraft 采用同一所有权原则，品牌根为 `~/OpenCraft`；每个 Projectless Thread 使用独立子目录。

## acceptance
- 无 cwd 的 `thread/start` 正常返回，目录位于配置的 `OpenCraft/thread-*` 下且 roots 与 cwd 一致。
- 两个 Projectless Thread 不共享目录；创建失败只回收自己创建且仍为空的目录。
- 显式绝对 Project 被规范化；相对、缺失、文件路径在进入 DSH 前返回稳定 fault。
- macOS/Windows 只共享逻辑 contract，Host 使用本机路径 API；相关 unit/integration、DSH bridge、typecheck、boundary 与 change-impact 通过。

## affected_paths
- `opencraft/apps/local-agent-host/src/projectless-workspace.ts`
- `opencraft/apps/local-agent-host/src/dsh-appserver-adapter.ts`
- `opencraft/apps/local-agent-host/src/main.ts`
- `opencraft/scripts/smoke-packaged-projectless-thread.ts`
- 聚焦测试、执行所有权设计和 Agent runtime 正式文档。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库/Task Pack/交付边界 | 不提交、不发布 |
| `opencraft/AGENTS.md@working-tree` | Desktop 路径与 Host owner | Renderer 不拼路径 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | 维护与验证方法 | 所有权和证伪 |
| `ref/codex/conversations/create-thread-for-target-09802.ts@66a586468` | Codex Projectless 目标 | Host resolve before start |
| `ref/wb/packages/agent-ui/src/utils/workspace-path.ts@66a586468` | WorkBuddy 跨平台逻辑根 | daemon 展开 `~` |

## evidence
- `tests/dsh-projectless-workspace.test.ts`：4/4，通过独享目录、显式 Project 规范化、稳定 fault 与创建失败空目录回滚。
- `tests/local-agent-host.test.ts`：13/13；真实 AppServer `thread/start` 无 cwd 时把 Host 创建目录传给 engine，失效显式路径不调用 engine。
- `scripts/smoke-dsh-projectless-workspace.ts`：真实 bundled DSH loader、模型配置与动态工具挂载通过；无 Project 的首个 Thread 在隔离 `OpenCraft/thread-*` 下创建。
- `scripts/smoke-packaged-projectless-thread.ts`：从最终签名 `.app` 启动全新 profile，不预置 Project，首条消息成功；Host 创建唯一 `OpenCraft/thread-*`，模型收到 2 次请求（会话与标题），未产生 `projects.json` 或页面错误。
- `npm run test:dsh-bridge`、完整 `npm run typecheck`、`npm run check:boundaries`、`npm run build:electron` 通过。
- 精确 change-impact 与完整 documentation validation 通过；`git diff --check` 通过。
- 最终 arm64 包 buildId `20260922155421-6bf71ccde297-projectless`；App/DMG 签名、DMG 校验与 ZIP 完整性通过，包内 daemon 包含 Workspace fault/resolver；未 notarize，Gatekeeper 状态单独披露。
- DMG SHA-256：`1218aeafb19c0afab2d1a647849c97546bc469ecfc96971d8cc42c80e369f1c2`；ZIP SHA-256：`d0a94ef9bd089a7d081180836cc65f87eefabc2f74b52f88a75da98f8590e89b`。

## decisions
- `~/OpenCraft` 是用户可见 Workspace 根；`~/.opencraft` 仍只保存内部数据。
- 每个 Projectless Thread 创建独享 `thread-<id>` 子目录，不让多个会话共享同一 cwd。
- 显式 Project 验证与 Projectless 创建复用一个 Host resolver；UI 不增加门禁或提示。

## handoff
- 源码、真实 DSH smoke、Electron 构建和最终 packaged smoke 完成；交付物位于 `/Users/skipzhang/Downloads/OpenCraft-20260922155421-projectless/`。未安装、提交、推送、notarize 或发布；`sourceRevision` 是基础提交，Projectless 修复仍为 working-tree 变更。
