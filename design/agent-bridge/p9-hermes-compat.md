# P9 Hermes 现有桥兼容回归

状态：本机确定性回归完成；未运行真实 Hermes gateway、真实 `hemesclient` 二进制或下游客户端，不构成真实产品验收。基线为 origin/main `114a08539e`；`apps/bridges/hermes` 源码、配置、部署、连接与能力声明均未改动。

## 为什么这样测

P9 的兼容对象是「旧桥的 AppServer 线格式」和「现有客户端」，不是新的 bridge 运行时。因此分成两层，共用一份录制：

1. `apps/bridges/hermes/tests/appserver-contract.test.ts` 用确定性 fake Hermes gateway 启动**真实的**现有桥 `startServer()`，按固定顺序走读取、历史、发送回执、steer、中断、队列和错误路径，把响应与通知规范化后与 `tests/fixtures/hermes-appserver-contract.json` 比较。
2. `tests/agent-bridge/hermes-compat.test.ts` 不启动桥，把同一份录制当作旧版服务端替身；用当前 `@opencraft/appserver-client`、`@opencraft/appserver-session` 和 `@opencraft/composer-appserver` 跑真实客户端读取、通知投影和发送回执路径。

录制只固定结构、ID 占位和时钟占位，不录 token、不启动模型、不访问网络、不执行工具。桥的源码没有为测试新增导出或分支。

## 覆盖的契约点

| 契约点 | 旧桥行为 | 回归断言 |
| --- | --- | --- |
| `initialize` | 固定返回 `unix/linux`、`hemesclient/0.1.0`，不带 `capabilities` | 当前客户端不要求任何扩展；客户端不调用 `opencraft/*` |
| 线程列表 | `session.list` → `thread/list`，可选游标，行内无 `catalog` 元数据 | 行 ID、排序、`nextCursor`/`backwardsCursor` 不变；当前客户端接受缺失 `catalog` |
| 线程读取 | `thread/read` metadata/full、`thread/resume`、`thread/turns/list`、`thread/items/list` | 当前历史读取与执行 resume 得到同样的 thread、turn、item 结构 |
| 读取历史项 | user/assistant/tool 消息映射为 `userMessage`、`agentMessage`、`dynamicToolCall` | item 类型、文本、工具名与参数保持不变 |
| 发送回执 | `turn/start` 返回带乐观 user item 的 `turn` | 命令端口 receipt 的 `threadId`、`turnId`、`acceptedAt`、`replayed` 不变 |
| 发送通知 | `turn/started`、`item/started`、`item/agentMessage/delta`、`item/completed`、`turn/completed` | 当前 `appserver-session` projector 得到完成 turn、agent 文本和既有 item 成员 |
| steer | `turn/steer` 返回 `{turnId}`，无 `disposition`、无 `opencraft/steerEvidence/updated` | receipt 保留 `turnId`，`disposition` 保持缺省，不误报 queue |
| 中断 | `turn/interrupt` 返回 `{}` | 当前命令端口发送原参数并正常完成 |
| 队列 | add/list/update/reorder/delete 的内存队列与 `thread/queue/changed` | 回执 `queuedSubmissionId` 和通知不变 |
| 错误 | 未支持方法返回 `-32601`；stale steer 返回 `-32000` 文本错误；Hermes gateway 失败带 `data.hermesCode` | 错误码、消息和 `hermesCode` 信封不变；`disconnected` 仍归类为结果未知 |

## 兼容观察与风险

1. **旧桥的 `turn/completed` 是“不完整 full 快照”。** 它只带 user 与最终 agent item，流式过程中已经发出的 tool item 不在快照里。当前客户端把 `itemsView: "full"` 当作成员权威，因此完成后的 turn 视图会按旧快照丢回流式 tool item。这是基线已有行为，不是本次新架构引入；P9 只锁定，不在 Hermes 侧修复。
2. **旧桥不宣告 `opencraft/steer-evidence`。** 当前 workbench runtime 会声明 `{version:1}`，但只有服务端明确返回可解析的 `query: true` 才请求 `opencraft/steer/status`。回归替身显式断言旧桥路径没有发出任何 `opencraft/*` 请求或 `opencraft/steerEvidence/updated` 通知。
3. **`thread/list` 的 `catalog` 必须继续可选。** 原生 AppServer 不提供该字段；缺失不能被解释为空目录或删除缓存行。
4. **`TurnSteerResponse.disposition` 必须继续可选。** 缺省仍表示旧的 steered 语义；只有显式 `queued` 才能改变客户端展示。

## 验证命令

```bash
# 桥自身测试（Bun；包含契约录制）
cd apps/bridges/hermes && bun test

# 当前客户端对旧桥录制的兼容回归
npm run test:agent-bridge

# 根类型检查
npm run typecheck
```

本机结果（2026-11-10）：

- `cd apps/bridges/hermes && bun test`：13 pass，0 fail。
- `cd apps/bridges/hermes && npm run typecheck`：通过。
- `npm run test:agent-bridge`：124 pass，0 fail。
- `npm run typecheck`：通过。

这些输出只证明本机确定性与类型边界，不代替实时环境输出。

## 缺口

- 本机没有可用的真实 Hermes gateway/`hemesclient` 运行环境，未执行真实 gateway token 发现、真实 session、真实下游 AppServer 路由或 Web/Electron/Expo 呈现验收。
- 契约录制来自现有桥源码与确定性 fake gateway，不包含真实 Hermes 版本、真实 transcript 或真实模型行为。
- 未修改、未部署、未重连任何 Hermes 组件；若后续在真实环境补测，应另存运行日志与版本证据，不能把本回归当作真实产品验收。
