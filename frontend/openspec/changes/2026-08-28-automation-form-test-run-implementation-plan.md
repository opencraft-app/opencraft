# 自动任务表单测试运行 Implementation Plan

**Goal:** 在自动任务新增和编辑弹窗中复用任务卡片的测试运行链路，真实执行当前未保存的表单内容且不保存正式任务。

**Architecture:** `HermesAgentAutomationsPanel` 继续统一管理测试状态、toast 和后台结果刷新；`AutomationFormModal` 只把当前受控字段组装成瞬时 `CronJob` 并调用面板回调。`startCronTestRun` 沿用临时一次性任务方案，并在草稿选择一个上游任务时通过现有 cron context 创建能力把该上下文带入试跑。

## Constraints

- 新增、模板新增和编辑弹窗都测试当前未保存内容，不先调用正式 create/edit。
- 测试运行不关闭弹窗，不修改原任务，不受正式调度时间、生效周期或多时间点脚本限制。
- 名称或任务说明为空、正在保存或正在测试时禁用“测试运行”。
- 复用现有测试运行反馈和后台结果刷新，不复制另一套异步编排。
- 国内站和国际站共用实现及现有 `测试运行` i18n key。
- 不新增依赖；实现严格按 RED → GREEN 验证。

## Tasks

- [x] 为 `startCronTestRun` 增加草稿上游 Context 测试，确认普通临时创建路径失败。
- [x] 在恰好一个上游任务时复用 structured cron context 创建并取得临时任务 ID；无上游路径保持不变。
- [x] 为新增、编辑、必填禁用和运行中按钮状态增加表单测试，确认弹窗尚无对应入口。
- [x] 为 `AutomationFormModal` 增加 `testState` / `onTestRun`，从当前字段构造瞬时 `CronJob`。
- [x] 将面板现有测试回调和状态传入普通新增、模板新增及编辑入口。
- [x] 在底部操作区增加次级“测试运行”按钮，不调用保存、不关闭弹窗。
- [x] 运行自动任务相关定向测试、`pnpm check`、`pnpm i18n:check` 和 `git diff --check`。
- [x] 核对最终差异只包含本功能代码、测试和 OpenSpec 文档。
