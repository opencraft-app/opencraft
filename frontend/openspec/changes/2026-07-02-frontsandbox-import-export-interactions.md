# 变更记录：诊断中心 Agent 备份与恢复交互优化

> **日期：** 2026-07-02
> **分支：** `frontsandbox/import-export-interactions`
> **规模：** M（single_agent）
> **TAPD：** 文字描述：优化诊断中心 Agent 备份与恢复导入/导出交互
> **MR：**
> **HEAD commit：** `df93362f`

---

## 一、需求概要

诊断中心已有 Hermes Agent 导入/导出能力，但界面更像 worker action 调试面板：导出和导入分成两行操作，日志混合展示，失败时会暴露 `timed out waiting ... last=PENDING` 等底层错误。用户难以判断当前任务类型、下一步动作和失败后的可恢复路径。

本次目标是把“Agent 备份与恢复”优化为诊断中心里的任务控制台，让用户围绕“备份到邮箱 / 从备份恢复”完成闭环：发起前有产品内确认，运行中有自动轮询和阶段文案，失败时有产品化主文案与可展开技术详情，导出和导入日志按任务归属展示。

## 二、任务完成情况

16/16 个任务完成。

### 任务 1: 梳理状态模型与错误文案

- [x] Step 1: 新增或导出纯 helper，覆盖任务类型、phase label、running 判断、friendly error 映射。
- [x] Step 2: 为 `last=PENDING`、TAT 超时、zip 损坏、邮箱缺失、未知错误补单元测试。
- [x] Step 3: 运行针对性测试，确认 helper 行为稳定。

### 任务 2: 替换导出/导入确认流程

- [x] Step 1: 新增 Agent 备份或恢复任务确认弹窗状态，支持 export/import 两种模式。
- [x] Step 2: 导出按钮改为打开确认弹窗，确认后调用现有 `startRescueExport`。
- [x] Step 3: 导入文件选择后打开确认弹窗，确认后调用现有 `importHermesWorkspace`。
- [x] Step 4: 未绑定邮箱、Agent 非 running、已有任务运行中时，就地展示原因并阻止发起。

### 任务 3: 重构面板展示为任务控制台

- [x] Step 1: 将导出/导入两条操作行收束为“当前任务 + 两个主动作”的控制台布局。
- [x] Step 2: 增加范围说明折叠区，默认保留一句“仅备份 Hermes Agent 相关文件”。
- [x] Step 3: 日志按任务归属展示，并为失败态提供“查看备份或恢复详情 / 复制备份或恢复信息”。
- [x] Step 4: 调整按钮、状态点、loading、空态，遵守 `rounded-md`、轻边框和紧凑工具感。

### 任务 4: i18n、测试与本地验证

- [x] Step 1: 运行 `cd frontend && pnpm i18n:extract`。
- [x] Step 2: 运行 `cd frontend && pnpm i18n:check`。
- [x] Step 3: 运行针对性 Vitest。
- [x] Step 4: 运行 `cd frontend && pnpm check`。
- [x] Step 5: 启动本地预览并 smoke `/agents/diagnostics` 面板。

## 三、关键决策

- 决策 1：保持后端 repository API 不变，在前端派生 `currentWorkspaceTask`。这样可以复用既有 `startRescueExport`、`importHermesWorkspace` 与状态查询接口，避免把一次交互优化扩大成后端协议改造。
- 决策 2：用产品内确认弹窗替代 `window.confirm`。导出确认展示目标 Agent、Agent 文件路径和邮箱通知；导入确认展示文件名、大小、目标 Agent 和覆盖风险，降低误操作成本。
- 决策 3：导出和导入后端状态仍独立，UI 层统一投射为一个“当前 Agent 备份或恢复任务”。优先展示运行中任务，否则展示最近一次终态，避免两条日志混在一起。
- 决策 4：错误处理采用“产品化主文案 + 原始详情可展开”的双层结构。用户先看到可行动的恢复建议，排障时仍能复制原始错误和日志。
- 技术选型：未引入新依赖；继续使用 React 19、TypeScript、Tailwind CSS v4、lucide-react、现有 i18n `useT()` / `rawT()` 与 Vitest。

## 四、实施摘要

- 主要影响文件：
  - `frontend/src/pages/marketing/agent-settings-page.tsx`
  - `frontend/src/pages/marketing/agent-workspace-recovery.ts`
  - `frontend/src/pages/marketing/__tests__/agent-workspace-recovery.test.ts`
  - `frontend/src/i18n/generated/*.json`
- 实施内容：
  - 新增任务类型、阶段文案、运行中互斥和 friendly error helper。
  - 新增导出/导入确认弹窗和本地 starting 状态。
  - 将诊断中心备份与恢复面板重构为任务控制台布局。
  - 日志按导出/导入归属展示，失败详情默认克制、可展开复制。
- 验证结果：plan.md 记录 `pnpm i18n:extract`、`pnpm i18n:check`、针对性 Vitest、`pnpm check` 与本地 smoke 已完成。

## 五、规范沉淀

本次无单独 Delta Specs 目录；需求规格已体现在归档记录中。后续如继续扩展诊断中心，应优先复用“任务控制台”模型：运行中任务优先、终态任务回顾、错误主文案与原始详情分层。

## 六、回顾与改进

### 踩坑记录

- 坑 1：后端失败信息可能直接暴露 `last=PENDING`、TAT 超时、zip 损坏等底层文本。解决方式是前端集中清洗常见错误，同时保留原始详情用于复制排障。
- 坑 2：导出和导入状态如果直接平铺展示，用户无法判断当前正在进行哪类任务。解决方式是派生统一的当前任务模型，并按任务归属展示日志。

### 可复用经验

- `agent-workspace-recovery.ts` 中的阶段文案、错误清洗和任务状态派生可以复用到后续诊断中心的 worker action 类任务。
- 产品内确认弹窗 + 本地 starting 状态 + 自动轮询，是把 worker action 从“调试面板”包装成用户任务控制台的一套通用模式。

### 未实现 / 后续优化

- 本次未新增取消任务能力；如果后端 cancel 路由稳定，可在下一轮为运行中备份或恢复任务补“取消”操作。
- 本次不改变导出范围，仍只备份 Hermes Agent 相关文件；如果后续要扩展到整机恢复，需要单独定义风险提示和后端契约。
