# LightVela Collaboration Extension

OpenCraft 的 first-party Trusted Extension，目标是在 `chat.lightvela.com` 提供 Server、
统一 IM Chat + Members 与 Computer 产品界面。当前 Workspace 已提供 Server 切换、Channel、
Members、群聊/私聊、消息发送，以及只读 Computer 列表/详情；Tasks/Reminders 暂不进入插件。

边界：

- Human 登录由 Application-owned `LightVelaAccountService` 统一持有；本扩展只借用认证请求端口。
- collaboration 后台持有业务事实与腾讯云 IM 资源映射。
- Human Web 通过本扩展内的 `@tencentcloud/chat` Adapter 直连腾讯云 IM。
- Agent/Host Runtime 继续由 `lightvela.hermes` 与 `vela-computer` 持有；本扩展不注册 Bot contribution。
- 腾讯 IM SDK、连接与消息 snapshot 属于 Extension activation/service 生命周期，不属于 React View。
- Computer View 只读取 Server 已有映射，不提供外部 Enrollment、安装脚本或 TAT 纳管入口。
- Computer 创建只允许选择当前 LightVela 账户下已有实例；本页面不购买或新建实例。
- 腾讯 IM Chat 不 import 或复用 Codex Thread/Turn/Activity/Composer 状态。

验证：

```bash
npm test --workspace @opencraft/plugin-lightvela-collaboration
npm run typecheck --workspace @opencraft/plugin-lightvela-collaboration
npx tsx --test tests/lightvela-account-port.test.ts \
  tests/lightvela-collaboration-plugin.test.ts \
  tests/lightvela-collaboration-messaging.test.ts
```
