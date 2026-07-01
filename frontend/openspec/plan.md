# 需求名: 诊断中心 Agent 备份与恢复交互优化

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让诊断中心里的 Hermes Agent 备份与恢复从 worker 调试面板变成清晰、可恢复、自动推进的任务控制台。

**Architecture:** 保持现有 repository API 不变，在 `agent-settings-page.tsx` 内抽出前端状态派生、阶段文案和错误清洗 helper；UI 层将导入/导出状态统一投射成“当前 Agent 备份或恢复任务”，确认动作改用产品内弹窗，日志按任务归属展示。

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, lucide-react, existing i18n `useT()` / `rawT()`, Vitest.

---

## 任务 1: 梳理状态模型与错误文案

**角色**: developer

**影响文件**:

- Modify: `frontend/src/pages/marketing/agent-settings-page.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-workspace-recovery.test.ts`

**验收方式**:

- helper 能区分导出/导入当前任务、运行中互斥和最近一次终态。
- 常见后端原始错误能转成产品化主文案，并保留原始详情。

- [x] Step 1: 新增或导出纯 helper，覆盖任务类型、phase label、running 判断、friendly error 映射。
- [x] Step 2: 为 `last=PENDING`、TAT 超时、zip 损坏、邮箱缺失、未知错误补单元测试。
- [x] Step 3: 运行针对性测试，确认 helper 行为稳定。

## 任务 2: 替换导出/导入确认流程

**角色**: developer

**影响文件**:

- Modify: `frontend/src/pages/marketing/agent-settings-page.tsx`
- Modify: `frontend/src/i18n/generated/*.json`

**验收方式**:

- 不再使用 `window.confirm`。
- 导出确认展示目标 Agent、Agent 文件路径、邮箱通知。
- 导入确认展示文件名、大小、目标 Agent 和覆盖风险。

- [x] Step 1: 新增 Agent 备份或恢复任务确认弹窗状态，支持 export/import 两种模式。
- [x] Step 2: 导出按钮改为打开确认弹窗，确认后调用现有 `startRescueExport`。
- [x] Step 3: 导入文件选择后打开确认弹窗，确认后调用现有 `importHermesWorkspace`。
- [x] Step 4: 未绑定邮箱、Agent 非 running、已有任务运行中时，就地展示原因并阻止发起。

## 任务 3: 重构面板展示为任务控制台

**角色**: implementer

**影响文件**:

- Modify: `frontend/src/pages/marketing/agent-settings-page.tsx`
- Optional Modify: `frontend/DESIGN.md` 仅当发现需补充约定时

**验收方式**:

- 面板顶部能显示当前任务类型、阶段、最近更新时间和结果。
- 导出/导入日志不再无归属混合；详情默认克制，失败时容易展开。
- 空态有明确下一步行动。

- [x] Step 1: 将导出/导入两条操作行收束为“当前任务 + 两个主动作”的控制台布局。
- [x] Step 2: 增加范围说明折叠区，默认保留一句“仅备份 Hermes Agent 相关文件”。
- [x] Step 3: 日志按任务归属展示，并为失败态提供“查看备份或恢复详情 / 复制备份或恢复信息”。
- [x] Step 4: 调整按钮、状态点、loading、空态，遵守 `rounded-md`、轻边框和紧凑工具感。

## 任务 4: i18n、测试与本地验证

**角色**: reviewer

**影响文件**:

- Modify: `frontend/src/i18n/generated/zh-CN.json`
- Modify: `frontend/src/i18n/generated/en-US.json`
- Modify: `frontend/src/i18n/generated/zh-to-key.json`
- Test: relevant Vitest files

**验收方式**:

- 新文案被 i18n 抽取并校验通过。
- 类型检查通过。
- 诊断中心面板本地 smoke 覆盖空态、失败态、导入确认和运行中互斥。

- [x] Step 1: 运行 `cd frontend && pnpm i18n:extract`。
- [x] Step 2: 运行 `cd frontend && pnpm i18n:check`。
- [x] Step 3: 运行针对性 Vitest。
- [x] Step 4: 运行 `cd frontend && pnpm check`。
- [x] Step 5: 启动本地预览并 smoke `/agents/diagnostics` 面板。
