---
id: lightvela-site-chat-pinning-checkpoint-20261008
type: task
scope: 双站会话置顶任务的续接检查点。
triggers: ["会话置顶检查点", "双站发布续接", "OpenCraft 嵌入式会话"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-08-lightvela-site-chat-pinning.md
status: candidate
reviewed_at: 2026-10-08
review_due: 2026-11-08
revision: 1.0.0
precedence: task
derived: false
---

## stage
站点与嵌入式 Workbench 的置顶桥接已在隔离 worktree 完成。国内和国际生产配置的本地产物构建通过；源码交付及生产发布仍待评审与必要确认。

## verified
- 任务起点的 `origin/master` 为 `a7f604f2a`；OpenCraft 原生置顶由 MR !5064 合入，工作分支已平移到新的 `origin/master` `e32b6e8e9`。
- LightVela Agent 侧栏持有可见会话列表；嵌入式 Workbench 投影原生 `pinned` 状态和 Host 能力，并转发置顶操作。
- OpenCraft `test:thread-lifecycle` 99 项通过，受影响工作区类型检查及 `check:boundaries` 通过。
- 前端在新 `master` 上的 `pnpm check` 通过，新增 TypeScript 诊断为零；会话、桥接、侧栏和发布矩阵聚焦测试共 110 项通过。
- `eo:cn-lightvela-prod-next` 与 `eo:global-lightvela-intl-prod-next` 生产配置本地构建通过，两个输出包含相同的 OpenCraft 嵌入版本。
- 新 `master` 上的 `pnpm build` 通过；全量 `pnpm test` 出现多处无关用例失败，Vitest worker 达到 4 GB 堆上限。单独复跑的 Agent 续费旧测试缺少 mock，并使用过时导航预期。

## unverified
- OpenCraft Agent Console 生成副本须在源码提交后同步，因为 `sourceRevision` 来自 Git 历史。
- 远端分支、MR、合入后的 master commit、CI 产物、两个 EdgeOne 发布及线上置顶持久化尚未验证。
- 当前 shell 未设置 `BK_CI_ACCESS_TOKEN`。`devops-pipeline` skill 要求在 API 查询前取得浏览器授权或用户提供的 token，启动流水线前展示完整参数并获明确确认。

## discard
- 不需要浏览器本地置顶存储或独立站点置顶 API。
- `/tmp/lightvela-chat-pinning-{cn,global}` 是本地产物，不代表已归档的 CI 制品或生产部署。

## restore
- 工作目录 `/Users/pablozhong/.codex/worktrees/site-chat-pinning/lightvela`，分支 `codex/site-chat-pinning`。
- Task Pack 为 `docs/context/tasks/2026-10-08-lightvela-site-chat-pinning.md`。
- 生产目标 combo 和流水线 ID 见 `frontend/release-matrix.json`、`.ci/runtime/harness_ci/frontend_edgeone_release_trigger.py`。

## next_action
清理构建生成的无关文件、复核变更集和生成副本门禁，然后提交源码并按 Git 历史生成同步副本；发布流水线须等完整参数和用户确认。
