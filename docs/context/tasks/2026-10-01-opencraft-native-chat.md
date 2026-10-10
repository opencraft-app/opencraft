## goal

将 iOS Expo Bot「对话」切到 OpenCraft 自有 RN Chat、Composer 和会话运行时，沿用当前原生 Bot 抽屉和打包的 frontend Bot 功能。

## requirement_ids / requirement_refs / requirement_excerpt

- 本会话用户：「你expo手机端现在的chat用的是Agentchat 不符合预期。请你换成 opencraft 自己的chat吧。等一下 我们自己的chat也有web和rn版本吧？」

## interface_refs / data_structure_refs

- `@opencraft/chat-core`、`@opencraft/chat-render-web`、`@opencraft/chat-render-native`：共享模型与双端呈现。
- `WorkbenchFrameShared`、`WorkbenchRuntimeProvider`、`LightVelaHermesTransport`：Expo 原生 Chat 与会话运行时。
- `@opencraft/mobile-bot-bridge`：本地 DOM Bot 目录向原生容器传输 Bot 实例/Profile 身份。

## history_context

- 当前 iOS 原生抽屉的 Chat section 仍把打包 DOM 里的 frontend AgentChat 面板显示出来；Android 已通过 OpenCraft Expo Workbench 展示 RN Chat。
- frontend 的 `AgentChatMigrationSurface` 是网页嵌入实验，在移动 DOM 资产中并非可靠的 RN 呈现。

## acceptance

- iOS 抽屉选中「对话」后展示 OpenCraft RN Chat 与输入框，不渲染 AgentChat。
- Chat 连接与所选 Bot 的实例/Profile 一致；切换 Bot 后旧运行时释放。
- 其他 Bot 功能仍用打包的 frontend DOM，抽屉保留，Expo Go 可打包。
- 运行有界桥接测试、Expo/frontend 类型检查、Bot DOM 构建与 iOS bundle。

## affected_paths

- `opencraft/apps/workbench-expo/`、`opencraft/packages/mobile-bot-bridge/`、`opencraft/tests/mobile-bot-bridge.test.ts`、`frontend/src/mobile-dom/entry.tsx`、相关设计文档。

## required_context

- Context Router 命中 `agent-gateway-runtime`，必读 `docs/context/domains/agent-gateway-runtime.md`。

## context_receipt

- 已读根与 Expo 局部 `AGENTS.md`、`docs/context/domains/agent-gateway-runtime.md`、`opencraft/docs/mobile-bot-bridge.md`，确认传输层和页面所有权。

## risks

- TAT/真实 Bot 连接需要手机账号进行端到端验证；本地构建无法证明服务端会话可用。

## evidence

- Expo、LightVela Hermes 插件与 frontend 类型检查通过；Bot 桥接测试 3/3；DOM 资产 build/smoke 通过；iOS Expo bundle 通过（4696 模块）。
- RN Chat 使用现有 `WorkbenchFrameShared`、`WorkbenchRuntimeProvider`、`LightVelaHermesTransport`；DOM Chat 入口转交原生，不再挂载 AgentChat。
- 最终 iOS bundle 重跑通过，外部 Expo Go manifest 轻量核验通过；按用户要求没有下载完整预览 bundle。

## decisions

- Bot 目录桥接显式提供实例与 Profile，原生 Chat 不依赖账户级默认 Bot，也不通过网页 Chat 迁移开关。
- 嵌入模式复用 OpenCraft 的会话、输入与侧边栏逻辑，额外的原生会话工具条用 HeroUI Native 按钮。
- 第一次进入 Chat 后保持原生会话树挂载，切换 Bot 才释放旧连接，返回 Chat 不重复冷启动。

## handoff

- 源码与聚焦验证已完成；等待手机侧真实账号会话验证。没有提交、推送或发布。
