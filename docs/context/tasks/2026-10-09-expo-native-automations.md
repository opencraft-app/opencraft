# Expo 原生定时任务

## goal

Expo Agent Console 的定时任务列表与操作使用 React Native/HeroUI 控件呈现，复用 frontend 现有 Hermes Cron 客户端执行，避免同时维护第二套命令解析与权限规则。当前为待完成迁移；生产入口保持原站功能。

## non_goals

- 不改 Hermes 调度器、服务端 API 或生产配置。
- 不替换官网 `/agents` 的既有定时任务页面。

## requirement_refs / requirement_excerpt

- 用户指出 Expo 的「定时任务」值得整改，并明确「不再使用 DOM 技术，而是使用原生技术」。
- 本次以原生呈现和原有行为语义为验收；不能只给 WebView 换外壳。

## interface_refs / data_structure_refs

- `frontend/src/lib/hermes-cron-client.ts`: `CronJob`、任务 CRUD、测试运行、依赖删除。
- `opencraft/packages/mobile-bot-bridge/src/automations.ts`: 跨宿主的列表展示数据契约，不承载 Cron 命令。
- `frontend/src/mobile-dom/entry.tsx`: Bot 实例/Profile 目录仍由打包控制器发布；定时任务 DOM 面板不挂载。
- `opencraft/apps/workbench-expo/scripts/build-native-cron-client.mjs`: 从 frontend 的原 Cron 客户端构建随包 JS，网络、认证按请求目标走 Expo 端口，不从 WebView RPC 执行任务。

## history_context

- 当前 Expo 的 Bot 功能由打包 frontend runtime 呈现，左侧导航由 RN/HeroUI 呈现。
- `current_design_refs`: `opencraft/docs/mobile-bot-bridge.md`、`opencraft/docs/workbench-design-language.md`。
- `relevant_evolution`: `/agents-next` 共用 Expo Shell，Bot 切换维持同一会话、草稿与当前 Bot 身份。
- `superseded_refs`: 无。

## acceptance

- 选中定时任务时，用户看到和操作的是原生列表、状态、详情与编辑控件；原 DOM 定时任务面板不挂载。
- 切 Bot 后旧请求不能覆盖新 Bot；创建、编辑、暂停、恢复、删除与测试执行沿用原客户端。
- 窄/宽容量布局、键盘、错误/刷新/空态均可恢复；不得显示旧 Bot 任务。
- 至少通过共享客户端并发账号隔离检查、Expo 类型检查、Web 导出和 iOS bundle；明确运行时硬件限制。

### 与现有网页能力对齐后才允许切换入口

| 现有能力 | 原页所有者 | 原生迁移要求 |
|---|---|---|
| 官方模板与场景试跑、添加 | 模板目录与场景任务逻辑 | 原生筛选、试跑、启用及反馈 |
| 当前任务、已结束任务、最近执行 | Cron 列表与执行记录 | 分类、过滤、刷新及结果详情 |
| 智能任务、固定通知、脚本任务 | 表单与受管理脚本流程 | 三类创建、编辑、输入校验和回滚 |
| 每日/多时点、间隔、单次及生效窗口 | 时间规则与脚本 | 原规则、时区及过期保护 |
| 通知渠道、指定会话及测试投递 | 渠道状态与 deliver 规则 | 可用渠道选择、确认、失败处理 |
| 技能与上游关联 | 技能校验和依赖图 | 选择、校验、防环、删除前重读 |
| 网关状态、测试执行、结果查看/下载 | Bot 状态与测试运行 | 状态反馈、后台完成、执行结果 |
| 定时任务 → 会话及其反向切换 | AgentConsoleHostProjection | 控制器持续挂载，原会话与草稿不重置 |

## affected_paths

- `opencraft/packages/mobile-bot-bridge/`
- `frontend/src/mobile-dom/`
- `opencraft/apps/workbench-expo/src/components/`
- `opencraft/docs/` 与对应测试。

## required_context / context_receipt

- 根/OpenCraft/Expo/frontend AGENTS；frontend DESIGN；OpenCraft maintenance skill；Mobile Bot Bridge 设计。
- Context Router 对「Expo 定时任务界面控件审计与整改」无匹配，随后按 automations 精确搜索定位 frontend 真源。

## evidence / validation / risks / decisions / scan_scope / scan_output / handoff

- 原生化限定于定时任务内容区域；其余 Bot 功能和 Chat 仍使用预制 DOM。原客户端可通过 esbuild 构建到 Expo 包，带原始 target 的 native port 避免全局令牌被并发切换污染。构建产物检查禁止 DOM 全局访问。当前原生实现不接产品入口。
- 原站高级能力包括 0 Token 创建/编辑、通知渠道配置、技能、上游关联、生效窗口和执行记录正文；当前原生表单先覆盖普通 Agent 任务，现有高级任务可读取、暂停、恢复、测试、删除，不能把基础表单描述为功能全量对齐。
- 已接入最近执行记录列表；单次记录正文与原站其他高级配置仍未接入。原生列表在同一 Bot/账号内保留旧内容刷新；换 Bot 同步遮蔽旧列表。删除前重读并比对依赖，脚本清理失败单独提示，不把已删除的任务误报为未删除。
- 2026-10-09 用户反馈原生页功能差距明显，且「定时任务 → 会话」切换失败。已恢复原站定时任务页与持续挂载的会话控制器；iOS/Expo Web 不再渲染不完整的原生页。原生实现保留为未接线代码，默认启动/构建不再额外编译它。继续迁移的准入条件：模板/场景、三类任务创建编辑、通知渠道及测试、技能、关联/依赖、生效窗口、当前/结束/最近执行、记录正文，以及上述导航序列全部可用。
- 失败根因：原生定时任务分支在 `MobileBotRuntime` 中返回 `null`，卸载了 `AgentSettingsPage` 内的 `AgentConsoleHostProjection`；原生会话选择命令此时没有订阅者。恢复原页后，控制器继续发布该 Bot 的会话状态。新增预制 runtime smoke：定时任务与对话互切时原页与控制器投影都必须存在。
- 回退后验证：`OPENCRAFT_SMOKE_BOT=1 npm run smoke:mobile-bot-runtime`、Expo/frontend TypeScript、iOS JS bundle 均通过。smoke 使用本地 Bot 与 503 假接口，可证明挂载/投影切换，不能代替真实账号的会话选择和 iPhone 触摸测试。
- 2026-10-09 验证：Expo 与 frontend TypeScript、共享客户端并发账号/401 检查、定时规则模型测试、Expo Web `/agents-next` 导出、iOS JS bundle、预制 Bot runtime smoke、`git diff --check` 均通过。Web 导出及 iOS bundle 是编译证据；iPhone/iPad 真机输入、通知和长运行任务仍需实机验证。
- 扫描范围仅 Expo Host、打包 frontend 入口、Cron 客户端和现有任务页；不扫无关服务。
