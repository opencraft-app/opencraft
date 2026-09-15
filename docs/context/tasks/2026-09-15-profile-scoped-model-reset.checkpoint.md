## stage
实现与范围验证完成；FEAI native verify 已通过，当前停在 archive 等待用户明确指令。

## verified
- 隔离 worktree `/Users/pablozhong/codex/lightvela-profile-model-reset` 基于当时最新 `origin/master`，分支为 `fix/profile-reset-0915-current-bot`。
- 诊断中心的“重置模型配置”现通过当前 Bot 的后端 `profile_id` 调用 Profile-scoped Hermes helper，不调用实例重置 API，也不运行无作用域的 `acli backend reset-config`。
- 当前 Profile 会恢复并保留 reserved `custom` Provider、默认模型和凭证；删除其他 Provider、fallback、模型管理元数据以及仅被删除配置引用的凭证。
- 内置配置缺失、持久化校验失败或凭证清理失败时 fail closed，并按对应阶段回滚当前 Profile 的配置与凭证。
- 主 Bot 和具名 Bot 均可在存在其他 Bot 时执行；其他 Profile、工作空间、记忆、通道、技能与实例级配置不变。
- 聚焦回归 3 files / 127 tests passed；模型配置专项 7 files / 232 tests passed。
- `pnpm check`、`pnpm build:cn`、文档门禁、changed-path impact 门禁和 `git diff --check` 通过。
- 分支已 rebase 到当时最新 `origin/master` 并提交到 Gongfeng MR !4044；创建后回查为 opened、can_be_merged，commit check success。

## unverified
- 全量 `pnpm test` 存在与本改动无关的既有失败，并在开放句柄状态下未自行退出；本次已记录失败范围，不能声明全量测试通过。
- 未在真实登录 Agent 上执行破坏性重置；真实运行时与生产行为仍需发布后的授权回归，当前仅有源码、helper 沙箱和组件测试证据。
- MR !4044 尚未合并、发布或完成生产验证；后续状态必须重新查询，不沿用本 checkpoint 的快照。

## discard
- 不再采用实例级 `resetInstanceConfig`、AI Gateway Key 轮换、无作用域 `acli backend reset-config` 或从其他 Profile/产品目录复制模型的方案。
- 系统 Python 缺少 `cryptography` 导致的首轮 helper 测试失败已由 workspace bundled Python 重跑替代，不属于产品失败。
- `pnpm build:cn` 产生的 `frontend/next-env.d.ts` 与字体二进制漂移已恢复，不属于变更集。

## restore
- 核心实现：`frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/pages/marketing/agent-model-config/hermes-model-config-command.ts`、`frontend/src/pages/marketing/agent-model-config/model-config-client.ts`。
- UI/纯逻辑：`frontend/src/pages/marketing/agent-diagnostics-panel.tsx`、`frontend/src/pages/marketing/agent-reset-config.ts`。
- 测试、i18n、七份诊断文档、正式设计文档、Task Pack 与 FEAI brief/report 均属于本次变更。

## next_action
- 等待 MR !4044 的评审及后续门禁；archive、合并、发布和生产操作均未执行。
