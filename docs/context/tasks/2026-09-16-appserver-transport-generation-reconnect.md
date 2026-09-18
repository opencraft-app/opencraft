---
id: appserver-transport-generation-reconnect
type: task
scope: 重构 OpenCraft AppServer Host 重连所有权，使失败代次使用新的 Client 与 Transport。
triggers: ["AppServer 重连", "Transport 生命周期", "Host generation"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/packages/workbench-runtime/src/appserver-runtime.ts
  - opencraft/packages/appserver-client/src/registry.ts
  - opencraft/plugins/lightvela-hermes/src/transport/lightvela-hermes-transport.ts
status: active
reviewed_at: 2026-09-16
review_due: 2026-11-30
revision: 1.0.0
precedence: task
derived: false
---

## goal
让 Host Runtime 在一次 Client/Transport 初始化失败并完成销毁后，以新的物理 Transport 代次重连，停止复用永久关闭对象的无限循环。

## non_goals
- 不改变 AppServer 协议、Hermes RPC 或远端运行时。
- 不修改登录、TAT、Provider 凭据与生产实例。
- 不把普通 WebSocket 断线误判为整个 Host Runtime 销毁。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户授权，2026-09-16：梳理、重构、实现并落地重连生命周期模型；可参考 `ref/wb`。

## interface_refs / data_structure_refs
- `AppServerWorkbenchRuntimeConfig`：物理 transport 创建边界。
- `AppServerClientRegistry.remove`：Client 代次销毁边界。
- `LightVelaHermesTransport.close`：不可逆 Transport 终态。
- 不变量：`Host Runtime → Client generation → Transport generation`；已关闭 Transport 不得进入新 Client。

## history_context
- 当前实现首次初始化失败后删除 Client，删除同时永久关闭 Transport；Runtime 仍持有同一 `config.transport` 并继续自动重连。
- 桌面实时日志观察到超过 80 次固定 5 秒重试，均以 `LightVela Hermes transport is closed` 在毫秒级失败。
- `ref/wb` 的 `DaemonClient` 保存 transport factory；每次 `doConnect()` 递增 generation 并创建新 transport，旧 transport 仅属于旧 generation。

## acceptance
- 首次初始化失败会关闭第一代 transport。
- 下一次重连必须调用 factory 获得第二代 transport，并能完成 initialize。
- 同一 generation 的普通物理断线仍沿用既有 reconnect/恢复语义。
- 固定 transport 的现有调用方与测试保持兼容。
- 最新 Electron Preview 在已登录状态能从首次失败恢复，不再出现 disposed transport 循环。

## affected_paths
- `opencraft/packages/workbench-runtime/src/appserver-runtime.ts`
- `opencraft/apps/workbench-web/src/runtime/appserver-runtime-context.tsx`
- `opencraft/tests/chat-workbench-reconnect-policy.test.ts`
- 相关类型检查、AppServer 与桌面构建入口。

## required_context
- 路由查询 `OpenCraft AppServer Host runtime reconnect transport lifecycle generation refactor` 未匹配 Pack；按规则执行有界精确检索。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md` | OpenCraft 局部边界 | 约束验证和交付 |
| `opencraft/packages/workbench-runtime/src/appserver-runtime.ts` | Runtime 重连与初始化清理 | 定位旧 transport 复用 |
| `opencraft/packages/appserver-client/src/registry.ts` | Client 销毁语义 | 确认 remove 会 close transport |
| `opencraft/plugins/lightvela-hermes/src/transport/lightvela-hermes-transport.ts` | Transport 终态 | 确认 close 后不可复用 |
| `ref/wb/packages/workbuddy-app/src/desktop/daemon/client.ts` | 用户指定参考实现 | 采用 factory + generation 所有权模型 |

## evidence
- 桌面 DevTools：reconnect attempt 超过 80，状态 `closed`，错误 `LightVela Hermes transport is closed`。
- 源码：该错误只在 `disposed === true` 时产生。
- 红测：第一次执行 `chat-workbench-reconnect-policy.test.ts` 时，第二次连接仍调用第一代并失败为 `transport generation is closed`。
- 绿测：Runtime 接入 factory 后，同一测试观察第一代关闭、第二代创建并完成 initialize。
- 固定 transport 红/绿：失败初始化原会继续排定 timer；整改后取消 timer，并以 `fixed-transport-generation-closed` 停止自动重试。
- `ref/wb` 对照：`DaemonClient.doConnect()` 每次递增 generation，并从 `transportFactory` 创建新 transport；`dispose()` 才是永久终态。
- 最新 arm64 Electron Preview 已重建并精确重启 `release/preview` 主进程。真实已登录账号恢复 Bots `999 / New Bot / skip` 与群聊列表，操作菜单显示“模型设置”；新进程 Console 无 `appserver-reconnect` 循环，TAT proxy 与历史读取成功。

## risks
- 替换 Client/Transport 代次时不能泄漏 registry client、provider lease 或状态订阅。
- 不得为每次普通网络抖动无条件重建上层 Thread/Replica 所有权。

## validation
- 先运行新增重连回归红测，再实现并转绿。
- 运行 Workbench Runtime、AppServer、Bot 管理测试与全 workspace typecheck。
- 重建 arm64 Electron Preview，并在真实登录态观察连接日志与 Bots 列表。

## decisions
- 将 Transport 创建从 Host registration 时提前创建，改为 Runtime 每个 Client 初始化代次按需创建。
- 保持 Host Runtime、Thread/Replica 逻辑所有权稳定，仅在 Client 初始化失败清理后换物理代次。

## scan_scope
- `opencraft/packages/workbench-runtime`
- `opencraft/packages/appserver-client`
- `opencraft/apps/workbench-web/src/runtime`
- `opencraft/plugins/lightvela-hermes/src/transport`
- `ref/wb/packages/workbuddy-app/src/desktop/daemon`

## scan_output
- graphify 现有图未命中该调用链；当前源码与 `ref/wb` 有界检索作为权威。

## handoff
- Complete：源码、回归、桌面打包与真实登录态连接验收完成；未提交、未创建 MR、未发布生产。
