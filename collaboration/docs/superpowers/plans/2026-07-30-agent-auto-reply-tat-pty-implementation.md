# Agent 自动回复与 TAT PTY 实施计划

规格：
`../specs/2026-07-30-agent-auto-reply-tat-pty-design.md`

## 切片 A：PTY HTTP 契约与后台应用层

1. 修改 `platform/v1/openapi.yaml` 的 `TerminalSession`：
   - 增加 `protocol`、`authentication`、`terminal`；
   - 保留 `sessionId/webSocketUrl/expiresAt`；
   - 重新生成 Go server/client 与 TypeScript client types。
2. 在 `internal/ports/tencenttat` 增加 `TerminalSessionIssuer`、Target、Session 和稳定错误。
3. 为 Computer Repository 增加 Owner/Admin 读取能力；普通 Member 不能签发终端。
4. 先在 `computermanagement/service_test.go` 写失败测试，再实现：
   - 参数与权限；
   - Computer active、实例已绑定、TAT online；
   - Issuer 调用和响应校验；
   - 上游错误到平台错误码的映射。
5. 先在 `computer_handler_test.go` 写失败测试，再实现 strict handler 和 no-store headers。
6. 注册 `/terminal-sessions` 路由并补 bootstrap contract test。

## 切片 B：真实 Issuer Gateway Adapter

1. 以 httptest 写 RED，覆盖：
   - 精确 target JSON；
   - service bearer；
   - 禁止重定向；
   - body/frame 上限；
   - 非 2xx 与非法响应归一；
   - 不在错误中泄漏 URL、token 和上游 body。
2. 实现 `internal/adapters/tencent/tat/session_issuer.go`。
3. `chatserver serve` 增加成对可选配置：
   - `--tat-session-issuer-url`
   - `--tat-session-token-file`
4. 未配置时注入 unavailable issuer，平台其余能力正常启动。
5. token 文件必须是普通文件、权限 `0600`，不得跟随 symlink。

## 切片 C：共享 TypeScript TerminalPort

1. 在 `packages/client-core` 增加 `createTerminalSession` 和严格 schema guard。
2. 定义 Web 兼容 `TerminalSocket`、`TerminalPort` 和 PTY frame codec。
3. 测试并实现：
   - `SessionAuth → PtyStart → PtyReady`；
   - Base64 input/output；
   - resize、ping/pong、stop；
   - session/channel fencing；
   - 未知帧忽略；
   - `PtyError`、关闭、过期和畸形帧。
4. client-core 不导入 `node:*`、Ink 或终端库。

## 切片 D：Node TUI 终端

1. 增加 Node WebSocket adapter 与 stdin/raw-mode adapter。
2. 新增：

   ```text
   raft-client terminal --server <id-or-slug> --computer <id-or-name>
   ```

3. 签发后卸载/避开 Ink，使用独立 raw stdin/stdout 桥接。
4. 覆盖 SIGINT/SIGTERM、远端关闭、PtyError 和异常时的终端恢复测试。
5. JSON 模式只输出会话建立/结束的脱敏元数据，不输出认证载荷。

## 切片 E：Host 顺序语义与 Processing Ledger

1. 修改 `RuntimeAdapter` 输入，携带 `launchEpoch` 和稳定 MessageRef。
2. 写并发测试，冻结“同会话串行、不同会话可排队、旧 launch 丢弃”。
3. 实现输入记录与 outbound action 记录两个账本状态机。
4. 覆盖 `sending → outcome_unknown` 的崩溃窗口，禁止自动重发。
5. 账本只存引用和状态，不存正文与凭据。

## 切片 F：Capability Gateway 与显式 Reply

1. 先写安全测试：回环监听、token、过期、launch 吊销、来源会话锁定、重复 action。
2. 实现当前输入作用域的 `raft message reply`。
3. wrapper 生成并在同次调用重试中复用随机 `actionKey`。
4. Gateway 调用现有 `IMTransport.SendText`，成功后只记录腾讯 message ID。
5. Runtime stdout、assistant event、reasoning 和 tool event 均不得自动发送。

## 切片 G：Codex 与 Hermes Gateway

1. 从 clean-room Runtime 中迁移最小的 `runtimeapi`，去除 new-api 模块依赖。
2. 先迁移 Codex app-server Driver 及 fake app-server 测试。
3. 将 Driver 装配进单 Agent Runtime Manager，替换生产 `idleRuntime`。
4. 迁移 Hermes Gateway Driver 及 fake gateway 测试。
5. 未安装/不兼容时返回精确诊断；不得在 Runtime 之间静默回退。

## 切片 H：验收

1. 后台：`go generate ./...`、`go test ./...`、`go test -race ./...`、
   `go vet ./...`、generated drift、secret scan。
2. TUI：generate、typecheck、unit test、build。
3. fake 端到端：
   - Human IM → Agent → Runtime → explicit reply → Human IM；
   - HTTP issue → PTY auth/start/input/output/stop。
4. 真实 Canary 分开执行：
   - 腾讯 IM 自动回复；
   - managed `rins-*` TAT PTY。
