# 源码核验

- AuthenticationService 已有应用级 provider registry、凭据隔离和 session epoch，Connector 应借用，而非再建账号仓库。
- ExtensionSupervisor 的内部 contribution 有 prepare/commit/rollback/dispose，可直接接第一方 Connector Provider。
- AppServer DynamicTool 通道已有 Thread/connection ownership、取消与响应；Workbench 静态注册 browser/terminal 工具。
- 首次实现采用两个稳定模型入口，实际贡献通过会话绑定 handle 调用；不改 Hermes 协议，不承诺模型主动获知连接变化。
- Host 原生 OAuth completed 只有 server 名称、可选 Thread 和成功标志，缺少 Workbench operationId；参考 native MCP processor 的 broadcast 路径后，采用 single-flight/取消隔离，完成仅使状态可重读，连接与会话启用仍需新用户动作。
- DSH 动态调用存在 broker、engine plugin、native tool envelope 三层期限；只延长 broker 仍会在 10/12 秒终止。Host 统一计算期限并随内部 capability 注册下发，真实 13 秒延迟批准 smoke 证明链路没有提前关闭。
- 配置是领域执行意图，不是 UI preference；复用已持久化 ConversationBinding 的 scope 身份。跨进程保存设置不意味着旧访问 grant 可恢复。
- Octop 有 23 个内置服务，包含远端 MCP、HTTP/CLI gateway；并非只有 API Key，Notion/Ardot/滴答使用 DCR+PKCE。主配置页 2340 行，不能照搬；复用目录/引导语义，分离我们的 host adapter 与 UI。
- 用户已决定仅数据库保存。现有 `ConnectorConfigurationStore` 只能存无敏感客户端意图；新增 Host 凭据表不能通过该 store 回传 renderer。原生 MCP 仍是借用能力，不伪装已迁移它的存储。
