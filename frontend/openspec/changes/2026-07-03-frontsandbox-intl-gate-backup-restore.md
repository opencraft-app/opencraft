# 国际站 Agent 备份与恢复入口下线保护

> 归档日期：2026-07-03
> 分支：`frontsandbox/intl-gate-backup-restore`
> 变更类型：前端显隐与交互保护

## 1. 需求概要

国际站当前的 Agent 备份与恢复能力暂不具备可上线条件，需要先从默认诊断中心路径下线，避免用户直接触达有问题的导入 / 导出能力。国内站保持现有体验不变；国际站仅在控制台执行 `show()` 后，和“终端”“浏览器”等隐藏入口一样展示该诊断能力。

本轮只调整前端展示、确认弹窗挂载、状态查询和轮询门控，不改变后端 worker action、备份包格式或恢复流程。

## 2. 任务完成情况

- [x] 新增 Agent 备份与恢复显隐规则：国内站默认展示，国际站默认隐藏，国际站执行 `show()` 后展示。
- [x] 将诊断中心备份恢复面板、确认弹窗、初始状态查询和轮询统一接入显隐规则。
- [x] 补充 helper 单测，覆盖国内站展示、国际站默认隐藏、国际站 show 后展示三个场景。
- [x] 完成针对性 Vitest、TypeScript check 和 diff whitespace 检查。

## 3. 关键决策

- 复用现有 `showHiddenAgentTools` / `show()` 机制，而不是引入新的 region feature flag，确保该入口和“终端”“浏览器”等隐藏工具的调试展示模式一致。
- 显隐规则抽成 `shouldShowWorkspaceRecoveryPanel()` 纯函数，便于单测覆盖，也避免把 region 判断散落在大组件内部。
- 不只隐藏 JSX，还同步阻断状态查询和轮询，避免国际站默认隐藏时仍后台请求备份 / 恢复状态接口。
- 保持国内站默认展示，降低对既有诊断中心能力的回归风险。

## 4. 实施摘要

### 代码变更

- `frontend/src/pages/marketing/agent-workspace-recovery.ts`
  - 新增 `WorkspaceRecoveryVisibilityInput` 与 `shouldShowWorkspaceRecoveryPanel()`。
- `frontend/src/pages/marketing/agent-settings-page.tsx`
  - 基于 `isGlobal` 和 `showHiddenAgentTools` 计算 `shouldExposeWorkspaceRecoveryPanel`。
  - 备份 / 恢复初始查询、导出轮询、导入轮询均增加显隐门控。
  - 备份与恢复面板、确认弹窗挂载均增加显隐门控。
- `frontend/src/pages/marketing/__tests__/agent-workspace-recovery.test.ts`
  - 补充显隐规则单测。

### 验证记录

- `npx --yes pnpm@10.32.1 --dir frontend exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/agent-workspace-recovery.test.ts`
  - 通过，1 个测试文件，7 个测试用例。
- `npx --yes pnpm@10.32.1 --dir frontend check`
  - 通过。
- `git diff --check -- frontend/src/pages/marketing/agent-workspace-recovery.ts frontend/src/pages/marketing/agent-settings-page.tsx frontend/src/pages/marketing/__tests__/agent-workspace-recovery.test.ts`
  - 通过。

## 5. 规范沉淀

- `frontend/openspec/specs/marketing.md`
  - 补充 `/agents` 诊断中心中 Agent 备份与恢复入口在国内站 / 国际站的显隐规则。
  - 明确国际站默认不渲染该入口、不查询状态、不启动轮询；执行 `show()` 后才展示。

## 6. 回顾与改进

### 踩坑记录

- 本地已有 Next dev server 占用端口并持有同目录 lock，且该服务存在 `@tencent/universal-report` 解析失败问题，导致浏览器 smoke 暂未作为本轮确认依据。
- FEAI 归档脚本在 macOS `sed` 场景下对带 `/` 的分支名解析不稳定，归档时使用 `frontsandbox-intl-gate-backup-restore` 作为变更名。

### 可复用经验

- 临时下线能力时，需要同时处理“入口是否展示”和“隐藏状态下是否仍触发副作用”，避免用户看不到入口但接口仍被轮询。
- 与控制台隐藏工具同类的入口，应优先复用 `show()` 调试展示机制，减少新增开关和环境漂移。

### 后续 TODO

- 后续恢复国际站能力前，需要补充从真实页面触发的 E2E / smoke 验证，确认国际站默认隐藏、`show()` 后展示、国内站默认展示三条路径。
- 如果 Agent 备份与恢复继续扩展，建议为 `AgentSettingsPage` 的诊断中心拆出独立组件，减少大组件内的状态耦合。
