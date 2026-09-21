# 诊断中心会话修复

## 目标

在 Agent 诊断中心新增“会话修复”维护操作，调用 Hermes 官方会话修复命令处理 `state.db` 异常，并向用户展示可交互的常见报错说明。

## 范围

- 在现有维护操作区域新增“会话修复”卡片，所有 Profile/Bot 均可使用。
- 卡片描述为“用于修复会话中出现的异常问题，点此查看常见报错。”。
- “常见报错”使用项目内 Radix Popover：鼠标悬停、键盘聚焦和点击均可打开；内容可进入、可选择，并通过 Portal 避免父容器裁剪。
- 气泡内容保持两行：
  - `Sorry, I encountered an unexpected error.`
  - `Try again or use /reset to start a fresh session.`
- 点击“修复”后先展示可访问确认弹窗，明确修复会检查 `state.db` 且异常时由 Hermes 自动创建备份，再执行 profile 隔离命令 `hermes -p '<profile>' sessions repair`。
- 展示执行中状态；执行结束后在卡片附近保留成功或失败结果，并使用现有 toast 提供补充反馈。
- 国内站与国际站共用现有诊断组件，新增中文界面文案进入现有 i18n 体系。

## 非目标

- 不修改 Hermes 的 `state.db` 修复算法、备份格式或 CLI 实现。
- 不新增后端接口，不直接读写浏览器本地数据库。
- 不自动执行 `sessions repair --check-only`，不将修复动作改为页面加载时自动运行。
- 不调整现有“重置模型配置”“重置 Hermes”“工作区恢复”能力。

## 关键依据

- Hermes `0.21.3` 提供 `hermes sessions repair --check-only` 与 `hermes sessions repair`；后者会检查 `state.db`，检测到异常后默认备份并修复 schema/FTS。
- 当前 LightVela Hermes COS `latest.json` 指向 `0.21.3`。
- 前端已有 `withHermesProfile(...)` 和 `execDebugCommand(...)`，可按当前 `profileId` 执行命令。
- `frontend/src/components/ui/popover.tsx` 基于 Radix Popover 并使用 Portal，符合诊断面板的裁剪与键盘访问要求。

## 成功标准

- 诊断中心展示“会话修复”卡片、指定描述和“修复”按钮。
- “常见报错”可通过 hover、focus、click 打开产品内气泡，且不使用原生 `title`。
- 用户确认后只执行当前 Profile 的 `sessions repair` 命令；执行期间不能重复触发。
- 成功、非零退出码和命令异常均有可观察的卡片状态。
- 聚焦组件测试覆盖命令构造、气泡交互、确认流程、loading、防重复触发和成功/失败状态。
- 前端 lint、类型检查、聚焦测试及仓库 context 门禁通过。
