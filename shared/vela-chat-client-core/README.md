# Vela Chat Client Core

Renderer、SDK 与平台无关的聊天客户端契约，迁移自
`skipzhang/velachat@c0f8fa280d33ea3eb6edc8a32a679e0847d28def` 的
`web/packages/client-core`。

本目录当前先保留原始契约和测试，后续将把 TUI/Terminal 与旧独立登录能力移出，留下：

- Conversation/Message/Composer 领域类型；
- `MessagingPort`；
- collaboration OpenAPI 客户端边界；
- 可由 OpenCraft Web、Electron/Expo 与 `vela-computer` fixture 共同验证的稳定协议。

本包不得依赖 React、路由、浏览器存储、腾讯 SDK、网络全局对象或产品页面文案。
