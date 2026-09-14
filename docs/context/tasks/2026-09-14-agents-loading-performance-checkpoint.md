---
id: agents-loading-performance-checkpoint-2026-09-14
type: task
scope: Checkpoint for the Agent management initial-loading optimization.
triggers: ["/agents loading checkpoint", "Agent page performance handoff", "MR delivery checkpoint"]
owner: pablozhong
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-14-agents-loading-performance-checkpoint.md
status: active
reviewed_at: 2026-09-14
review_due: 2026-10-14
revision: 1.0.0
precedence: task
derived: false
---

## checkpoint

- 目标：缩短 `/agents` 初始加载并提交新的 MR。
- 当前基线：`origin/master@ff5035276`，分支 `codex/agents-loading-performance`。
- 已完成：路由级 lazy 边界、四个非当前面板 lazy 边界、移除页面级重复 Pass 刷新、已存在 Bot 时不再被 Pass 加载整页遮挡。
- 已验证：聚焦 Vitest 41 项、`pnpm check`、国内/国际构建、国内/国际浏览器回归、同 SHA 性能对比。
- 已知基线问题：全量 Vitest 的多个既有失败已在 detached master worktree 复现；本次未扩大修复范围。
- 交付边界：只提交源码与测试，不合并、不发布、不改 GitOps。
- 下一步：检查 staged change impact，commit、push、创建并回查工蜂 MR。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户要求修复 `/agents` 加载偏慢并提交新的 MR。

## interface_refs / data_structure_refs
- `frontend/next-site/agents-page-client.tsx` 的鉴权与 lazy 加载边界。
- `frontend/src/pages/marketing/agent-settings-page.tsx` 的 Pass 与面板加载边界。

## history_context
- `current_design_refs`：`docs/context/flows/tapd-gongfeng-delivery.md`、`docs/context/flows/change-delivery.md`。
- `relevant_evolution`：从路由和面板静态导入改为鉴权后、按需加载；去除页面级重复 Pass 刷新。
- `superseded_refs`：无。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@ff5035276` | 前端服务规则 | 确定验证门禁 |
| `docs/context/flows/tapd-gongfeng-delivery.md@ff5035276` | 交付流程 | 约束 MR 状态回查 |
