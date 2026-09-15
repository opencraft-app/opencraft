# Go 客户端与 SEA IM Bridge 实施计划

状态：历史实施计划，已由 `20-Vela正式AgentHost收敛.md` 取代
日期：2026-07-30
依据：`15-Go客户端与SEA-IM-Bridge设计.md`

> 本文记录已删除的 `cmd/chatserver-agent` 路线，不再定义正式发布物。后续开发、
> TAT 部署和验收一律以 Vela 收敛及退役规格为准。

## 1. 本计划目标

按测试先行方式完成：

```text
chatserverctl
  → 平台 HTTP API
  → TencentOperation
  → 腾讯云 TAT

chatserver-agent
  → POST /v1/runtime/session
  → chatserver-im-bridge
  → 腾讯云 IM
```

最终形成以下闭环：

1. 人类管理员通过平台登录并管理 Computer、Agent 生命周期。
2. 平台使用固定 TAT 模板部署并启动 Agent。
3. Agent 使用本地 Runtime Credential 换取短期 Access Token 和自身 UserSig。
4. Agent 通过 SEA Bridge 直接登录腾讯云 IM。
5. Agent 收到 C2C、群聊/话题提及和平台 CustomElem，并可直接回复。
6. 普通消息不经过平台后台，也不写入平台数据库。

## 2. 固定工程边界

### 2.1 Go 入口

保留现有后台入口：

```text
cmd/chatserver
```

新增两个独立 Cobra 入口：

```text
cmd/chatserverctl
cmd/chatserver-agent
```

不把现有稳定的后台 `flag` CLI 强行改造成 Cobra。

### 2.2 Go 包

计划新增：

```text
internal/agenthost/
├── credential/
├── im/
├── bridge/
├── platform/
└── host/

internal/agentcli/
internal/ctlcli/
```

`internal/runtime` 已用于后台 API/Worker/Scheduler 进程角色，不承载远端 Agent
Runtime，以免两个 Supervisor 概念混淆。

### 2.3 Node Bridge

计划新增：

```text
bridge/
├── package.json
├── package-lock.json
├── src/
├── test/
├── scripts/
└── THIRD_PARTY_NOTICES.md
```

固定原则：

- 正式 SEA 基线使用 Node 24 LTS；
- 腾讯 IM SDK 使用官方 `@tencentcloud/lite-chat` Node export；
- v1 先验证并固定 `@tencentcloud/lite-chat@4.4.2`、`ws@8.21.1`；
- 只生成一个 CommonJS bundle；
- 每个目标 OS/架构单独构建、校验并启动测试；
- 目标机不安装 Node.js、npm 或 `node_modules`。

### 2.4 OpenAPI

`platform/v1/openapi.yaml` 继续是唯一 HTTP 事实源。

现有 `server.gen.go` 保持服务端生成；新增同包 `client.gen.go`，只生成客户端，不重复
生成模型。CLI 和 Agent 不手写 HTTP DTO。

## 3. TDD 与生成门禁

除依赖锁文件、生成代码和构建配置外，严格执行：

```text
写一个最小失败测试
→ 运行并确认因目标行为缺失而失败
→ 写最小生产代码
→ 运行并确认通过
→ 小步重构
→ 再运行受影响包和全仓测试
```

测试替身只替代真正的外部边界：

- 平台 HTTP 使用 `httptest.Server`，响应结构与 OpenAPI 完整一致；
- Bridge 使用真实子进程测试替身，验证标准输入/输出和退出行为；
- Node Bridge 的腾讯 SDK Adapter 使用行为完整的 fake；
- TAT/IM 云端 Adapter 使用端口级 fake，不测试 fake 自身；
- Canary 才调用真实腾讯云。

每个任务完成后必须把 RED、GREEN、文件变更和异常记录到 `progress.md`。

## 4. 第一阶段：协议与生成客户端

### 任务 1：供应链和 Node SDK 探针

新建：

```text
bridge/package.json
bridge/package-lock.json
bridge/test/sdk-import.test.cjs
bridge/THIRD_PARTY_NOTICES.md
```

验证：

- 锁文件不存在浮动版本；
- Node 条件导出实际加载 `node.js`，不落到浏览器 `standard.js`；
- 无 DOM 环境可以加载 SDK；
- `ws` 可以被显式注入或由 SDK 正确加载；
- 包许可证、tarball integrity 和版本进入 NOTICE；
- 安装脚本不执行未审查的生命周期脚本。

本任务是依赖/配置探针，不写业务生产行为。探针不通过时停止，不进入 Bridge 实现。

### 任务 2：从同一 OpenAPI 生成 Go Client

修改：

```text
internal/api/openapi/generate.go
internal/api/openapi/generation_test.go
scripts/generated.txt
```

新建：

```text
internal/api/openapi/client.oapi-codegen.yaml
internal/api/openapi/client.gen.go
```

生成要求：

- `models: false`；
- 使用同包现有模型；
- 生成 `ClientWithResponses`；
- 覆盖全部现有 operation；
- 连续生成两次无漂移；
- `RuntimeSession` 字段与 OpenAPI 完全一致；
- 敏感字段不会被生成代码自动打印。

验收：

```text
go generate ./internal/api/openapi
go test ./internal/api/openapi
./scripts/check-generated.sh
```

### 任务 3：IMTransport 与 Bridge 协议值对象

新建：

```text
internal/agenthost/im/transport.go
internal/agenthost/im/types.go
internal/agenthost/im/types_test.go
internal/agenthost/bridge/protocol.go
internal/agenthost/bridge/protocol_test.go
```

RED：

- 非法 conversation type、空 message ID 和空目标不可构造；
- Request/Result/Event 三类信封不能混淆；
- 未知字段可读取，未知命令返回稳定错误；
- 敏感字段类型的 `String`/`GoString` 必须固定返回 `[REDACTED]`，且通用 JSON
  序列化必须拒绝；
- 编码后的错误不包含 UserSig 或 Runtime Credential；
- 8 MiB 边界和超限行为确定；
- `launch_id` 是所有异步事件的必需字段。

GREEN：

- 定义稳定 `IMTransport`；
- 定义文本、CustomElem、消息引用和统一事件；
- 定义 Bridge v1 JSON Lines 信封和稳定错误码；
- 业务类型不暴露腾讯 SDK 私有对象。

## 5. 第二阶段：Go Agent 宿主

### 任务 4：Runtime Credential 安全文件

新建：

```text
internal/agenthost/credential/file.go
internal/agenthost/credential/file_test.go
```

RED：

- 只接受绝对路径、普通文件、非符号链接和权限 `0600`；
- 拒绝空文件、超大文件、包含换行或非法 credential；
- 错误、格式化和日志不返回 credential 原文；
- Windows ACL 校验能力单独封装；未能确认仅当前服务账号可读时拒绝启动；
- 读取后不生成临时副本。

GREEN：

- 返回显式格式化也只显示 `[REDACTED]`、且不能通用 JSON 序列化的敏感值；
- 只有平台请求编辑器可以显式读取；
- 诊断只输出文件是否安全，不输出内容。

### 任务 5：Runtime Session 平台客户端

新建：

```text
internal/agenthost/platform/client.go
internal/agenthost/platform/client_test.go
```

RED：

- 精确发送 `Authorization: AgentCredential <secret>`；
- 只接受 HTTPS，测试回环 HTTP 必须显式开启；
- 完整解析 OpenAPI `RuntimeSession`；
- 校验 Agent UserID 与 IM UserID 一致；
- 校验所有到期时间在未来并设最大可接受 TTL；
- 401 credential revoked/stale 是终止错误；
- 429/5xx 是可重试错误并保留 Retry-After；
- 响应体、Header、错误和日志均不泄漏 credential/UserSig。

GREEN：

- 在生成 Client 外增加最薄的 Agent 专用安全封装；
- 不复制 DTO；
- 返回内部不可变 Session 值对象；
- 提供短期 Runtime Bearer 的安全 request editor。

### 任务 6：Bridge 子进程与 JSON Lines 传输

新建：

```text
internal/agenthost/bridge/process.go
internal/agenthost/bridge/process_test.go
internal/agenthost/bridge/codec.go
internal/agenthost/bridge/codec_test.go
internal/agenthost/bridge/testdata/
```

RED：

- Bridge 只能通过已校验的绝对路径启动；
- UserSig 只出现在标准输入帧，不进入 args/env；
- `ready` 超时、异常退出、畸形 JSON、非协议 stdout、超大行均失败；
- 每个 request ID 只完成一次；
- 请求取消会释放 pending map；
- stderr 日志经过脱敏并有总量限制；
- 优雅 `shutdown` 超时后强制结束；
- 父 Context 取消后不存在残留子进程。

GREEN：

- 使用真实 helper 子进程测试 stdin/stdout/stderr/exit；
- 不给生产代码增加测试专用入口；
- 并发请求和异步事件分别投递；
- 退出顺序确定且无 goroutine 泄漏。

### 任务 7：SEAIMTransport

新建：

```text
internal/agenthost/bridge/transport.go
internal/agenthost/bridge/transport_test.go
```

RED：

- `Start` 必须完成 initialize、ready、login；
- login 前不能发送消息；
- 文本和 CustomElem 正确映射；
- Bridge error 映射为稳定 Go error；
- 网络状态事件不会被误当作消息；
- 未知 Element 被保留为 unknown，不导致断连；
- `Close` 幂等；
- 旧 `launch_id` 事件不会进入当前 `Events()`。

GREEN：

- `SEAIMTransport` 完整实现 `IMTransport`；
- 不在该层解释 Task、Reminder 或 replyPolicy。

### 任务 8：Agent Host 会话与监督器

新建：

```text
internal/agenthost/host/config.go
internal/agenthost/host/host.go
internal/agenthost/host/host_test.go
internal/agenthost/host/backoff.go
internal/agenthost/host/backoff_test.go
```

RED：

- 启动时先取得 Runtime Session，再启动 Bridge；
- 续期时间取平台 Token 和 UserSig 中较早到期者，并提前加抖动；
- 新 Session 使用新 launch，旧 launch 输出全部丢弃；
- Bridge 崩溃按 1s 到 30s 指数退避；
- 连续失败到阈值后宿主退出；
- credential revoked、Agent stopped 不无限重试；
- 正常关闭停止 intake、等待 in-flight，再关闭 Bridge；
- 使用 fake Clock 驱动测试，不依赖真实 sleep。

GREEN：

- Host 只编排 Session、IMTransport 和 RuntimeAdapter；
- Canary Adapter 与真实 Runtime Adapter 分离；
- 不在 Host 保存普通消息历史。

### 任务 9：`chatserver-agent` Cobra CLI

新建：

```text
cmd/chatserver-agent/main.go
internal/agentcli/root.go
internal/agentcli/root_test.go
internal/agentcli/run.go
internal/agentcli/doctor.go
internal/agentcli/canary.go
```

共享修改：

```text
go.mod
go.sum
```

RED：

- `run/doctor/canary/version` 命令和中文帮助稳定；
- 不接受 credential 字符串参数或环境变量；
- 只能接受 `--credential-file`；
- JSON 和人类输出都不含 Secret；
- SIGTERM 能优雅停止；
- Bridge 路径默认取同目录固定文件，也可通过仅供开发的显式绝对路径覆盖；
- `doctor` 不发送业务消息；
- `canary` 必须有显式测试会话和超时，不能误进入生产无限循环。

GREEN：

- Cobra 成为直接依赖；
- 入口只负责参数、装配、信号和退出码；
- 业务行为继续留在 Agent Host。

## 6. 第三阶段：Node SEA Bridge

### 任务 10：Node 协议核心

新建：

```text
bridge/src/protocol.cjs
bridge/src/main.cjs
bridge/src/redaction.cjs
bridge/test/protocol.test.cjs
bridge/test/process.test.cjs
bridge/test/redaction.test.cjs
```

RED：

- initialize/login 顺序错误返回稳定错误；
- 每行恰好输出一个 JSON result/event；
- stdout 不允许日志或堆栈；
- 未知命令不崩溃；
- 超大输入、畸形 JSON 和重复 request ID 行为确定；
- UserSig、消息正文和 CustomElem data 不进入 stderr；
- shutdown 后不再接受请求。

GREEN：

- 使用 Node 内置 `node:test`；
- 协议核心只依赖抽象 SDK Adapter；
- stdout 与 stderr 职责物理分离。

### 任务 11：腾讯 `lite-chat` SDK Adapter

新建：

```text
bridge/src/tencent-im.cjs
bridge/test/tencent-im.test.cjs
bridge/test/fixtures/
```

RED：

- SDK 实例按 SDKAppID 创建、按 Agent UserID 登录；
- login、logout、sendText、sendCustom 参数正确；
- C2C、Group、Topic、文本、CustomElem、mention 和 unknown element 投影稳定；
- SDK ready、network、kicked out、error 事件映射正确；
- SDK Promise rejection 不成为 unhandled rejection；
- 同一进程拒绝切换到另一个 Agent 身份；
- 无真实 UserSig 的测试不访问公网。

GREEN：

- 只封装官方公开 SDK API；
- 不依赖 TIMBot-WS 运行时代码；
- 不支持的流式 Element 作为 unknown 处理。

### 任务 12：可复现 SEA 构建

新建：

```text
bridge/scripts/build-sea.mjs
bridge/scripts/verify-sea.mjs
bridge/sea-config.json
bridge/.npmrc
scripts/build-release.sh
```

验证：

- 使用固定 Node 24 LTS patch 版本；
- 固定 bundler 和注入工具版本/integrity；
- bundle 选择 Node export，输出单 CommonJS 文件；
- 构建产物不依赖工作目录、系统 Node 或 `node_modules`；
- 独立临时目录启动产物并完成 initialize/ping/shutdown；
- Linux amd64 与 Windows amd64 分别在原生 CI runner 构建；
- 产物生成 SHA-256、版本清单和第三方许可证；
- 重复构建的逻辑内容可复算；若平台签名导致二进制 hash 不同，签名前产物 hash 必须稳定。

本任务完成前，SEA 仍视为开发产物，不进入 TAT 模板。

## 7. 第四阶段：后台 Runtime 与 TAT 闭环

### 任务 13：组合认证器与 Agent Credential Currentness

新建：

```text
internal/ports/runtimeauth/repository.go
internal/adapters/runtimeauth/ent_repository.go
internal/adapters/runtimeauth/ent_repository_test.go
internal/adapters/authn/composite.go
internal/adapters/authn/composite_test.go
internal/adapters/authn/agent_credential.go
internal/adapters/authn/agent_credential_test.go
```

修改：

```text
internal/app/authn/service.go
internal/transport/http/authentication.go
```

RED：

- Human、RuntimeBearer、AgentCredential 由 CandidateKind 精确分派；
- credential 路由提示可选择 server shard，但不能单独授权；
- 服务端解析 serverId/agentId/version 后仍验证强哈希；
- revoked、旧 version、Agent 已删除或未运行均拒绝；
- 不按 secret hash 做全库扫描；
- 认证成功只返回 ID 与 version，不保留明文；
- 并发轮换时旧凭据立即失效。
- 修正既有 `SensitiveCredential` 的格式化行为，保证 `%v/%+v/%#v` 都不显示原文。

GREEN：

- 复用现有 `agent_runtime_credentials` 表；
- 不增加 Credential 表；
- 组合认证器替代 Handler 特判。

### 任务 14：Runtime Token 与 UserSig Provider

新建：

```text
internal/ports/tencentim/usersig.go
internal/adapters/tencent/im/usersig.go
internal/adapters/tencent/im/usersig_test.go
internal/adapters/authn/runtime_bearer.go
internal/adapters/authn/runtime_bearer_test.go
```

修改：

```text
internal/ports/token/signer.go
internal/adapters/token/hmac_jwt.go
```

RED：

- Runtime Token 与 Human Token 用途严格隔离；
- Token 包含 serverId、agentId、credentialVersion、到期时间；
- UserSig 只为当前 Agent UserID 签发；
- SDKAppID、UserID、过期时间错误时拒绝；
- 使用官方测试向量验证 UserSig；
- IM 管理员密钥只通过安全配置 Provider 注入；
- 错误和日志不泄漏签名密钥或 UserSig。

GREEN：

- 固定经核验的 UserSig Go 依赖版本；
- Access Token 与 UserSig TTL 分开配置；
- Runtime Host 按两者较早到期时间续期。

### 任务 15：Runtime Session HTTP 纵向闭环

新建：

```text
internal/app/runtimesession/service.go
internal/app/runtimesession/service_test.go
internal/transport/http/runtime_handler.go
internal/transport/http/runtime_handler_test.go
internal/bootstrap/runtime_api.go
internal/bootstrap/runtime_api_test.go
```

RED：

- `POST /v1/runtime/session` 只接受 AgentCredential；
- 返回完整 OpenAPI `RuntimeSession`；
- Agent ID、serverId、userId、replyPolicy、runtime 与数据库当前事实一致；
- Agent IM 未 ready、Computer 未绑定或 Agent 未处于可运行状态时拒绝；
- response 强制 `Cache-Control: no-store`、`Pragma: no-cache`；
- `GET /v1/runtime/me` 只接受 RuntimeBearer；
- Handler、middleware 和 access log 不泄漏敏感响应。

GREEN：

- Handler 只映射 DTO；
- Application 负责 currentness、Token 和 UserSig 编排；
- 只把这两个真实 operation 加入 ImplementedRoutes。

### 任务 16：腾讯 TAT Port、Adapter 与固定模板

新建：

```text
internal/ports/tencenttat/client.go
internal/adapters/tencent/tat/client.go
internal/adapters/tencent/tat/client_test.go
internal/app/tencentoperation/worker.go
internal/app/tencentoperation/worker_test.go
internal/app/agentlifecycle/templates.go
internal/app/agentlifecycle/templates_test.go
```

RED：

- 所有调用强制使用 Computer 的 `tatRegion` 和 `tatInstanceId`；
- 只允许 deploy/start/stop/restart/probe/credential-install 模板；
- HTTP/API 输入无法注入 command、args、env 或绝对路径；
- operationId 贯穿重试；
- 查询可重试，结果未知先查询再决定；
- Runtime Credential 明文只存在于 worker 内存与一次 TAT 请求；
- TAT 请求、operation snapshot、result 和日志不保存明文；
- TAT throttling、offline、timeout、stale revision 映射为稳定状态；
- Adapter 使用官方 Go SDK，但领域层不引用 SDK 类型。

GREEN：

- 平台节点从安全运行环境获得腾讯云凭据；
- 不在配置文件或数据库保存 SecretId/SecretKey；
- Worker 使用数据库租约消费 `tencent_operations`；
- 同一 Agent/Computer 生命周期按资源键串行。

### 任务 17：最小 Server、Channel、Computer 与 Agent 管理面

按现有 OpenAPI 小步实现以下 operation：

```text
Server: create/list/get
Channel: create/list/get
Computer: create/list/get/refresh/registration
Agent: create/list/get/update/deploy/start/stop/restart/credential-rotate
Operation: get
```

每个领域继续使用：

```text
transport → application → port → Ent/Tencent adapter
```

RED：

- 所有资源受 Server membership/role 保护；
- 创建 Server 可靠建立 IM Community 与 `#全员`；
- 创建 Channel 可靠建立 Topic；
- 创建 Agent 可靠导入普通 IM UserID；
- Agent 必须绑定当前 Server 的 Computer；
- deploy/start/stop/restart 只创建受限 TencentOperation；
- credential 不在任何 HTTP response 中返回；
- operation 查询只能访问当前 Server；
- 外部 Computer 只运行一个 `chatserver-computer`，批准的 Rust TAT core 通过
  staticlib + CGO 内嵌；
- 后台返回结构化注册码，Computer 通过 C ABI 注册并写入
  `chatserver-computer-id:<computer_id>` 标签，不执行 shell；
- 注册对账按标签得到唯一 `rins-*` 后才把 Computer 置为 active；
- TAT Worker 已接入统一 serve，注册窗口内持续发现，过期稳定失败；
- `TATInstanceBinding` 先占用再写 Computer，避免同一实例跨 Server 重复绑定；
- Computer refresh 直接探测 TAT Computer，并持久化 online/offline 事实；
- SQLite 单 Writer 下事务、Outbox 与 operation 原子；
- 重复请求使用幂等键，不重复创建腾讯资源。

GREEN：

- 复用已有 21 张表；
- 不增加普通消息、Invocation、Delivery 或 Computer connection 表；
- 云端副作用全部通过可靠 operation 执行。

## 8. 第五阶段：管理员 CLI 与真实 Canary

### 任务 18：`chatserverctl` Cobra CLI

新建：

```text
cmd/chatserverctl/main.go
internal/ctlcli/root.go
internal/ctlcli/root_test.go
internal/ctlcli/session_store.go
internal/ctlcli/session_store_test.go
internal/ctlcli/auth.go
internal/ctlcli/resources.go
internal/ctlcli/operations.go
```

RED：

- login 通过终端安全读取密码，不接受 password 参数；
- Access/Refresh Token 使用权限受限文件和原子改名；
- logout 清理本地会话并调用平台；
- Token 到期可安全 refresh；
- Computer/Agent 命令只调用平台 API；
- operation wait 使用轮询、Context 和最大超时；
- CLI 不接受 CAM 或 IM 管理员密钥；
- 输出中文，`--json` 与退出码稳定且不泄漏 Secret；
- 不存在 `tat exec` 或任意命令入口。

GREEN：

- 只使用生成的 OpenAPI Client；
- Human session 与 Agent credential 的存储和命令树完全分离。

### 任务 19：本地全链路与真实 Canary

本地集成：

- 真实 Go Agent Host；
- 真实 SEA Bridge 进程；
- 假平台 HTTP；
- 假腾讯 SDK Adapter；
- 崩溃、续期、重连、重复事件和关闭故障注入。

真实 IM 子门禁使用默认跳过的：

```text
go test -tags=canary ./internal/integration \
  -run '^TestTencentIMSEAEndToEnd$' -count=1
```

只有同时显式设置 `CHATSERVER_RUN_LIVE_CANARY=1`、
`CHATSERVER_IM_CANARY_SDK_APP_ID`、`CHATSERVER_IM_CANARY_SECRET` 和
`CHATSERVER_IM_CANARY_BRIDGE` 时才访问真实腾讯云。测试创建两个随机普通 UserID，
分别启动独立 SEA Bridge，验证 C2C 文本与 CustomElem 的发送回执和接收事件。环境
变量值不得出现在命令历史、CI 日志或测试输出中。

真实 Canary：

1. 使用隔离的测试 Account、Server、Computer、Human 和 Agent。
2. 平台后台从安全环境读取腾讯云凭据。
3. `chatserverctl` 通过平台触发 TAT 部署和启动。
4. Agent Runtime Credential 只落到目标机器 `0600` 文件。
5. Agent 取得自身短期 UserSig 并登录腾讯 IM。
6. 完成 C2C、群聊/话题明确提及、CustomElem 和回复。
7. 模拟断网并验证离线补偿。
8. 模拟 UserSig 续期和 Bridge 崩溃。
9. 验证平台数据库没有普通消息正文。
10. 验证源码、fixture、日志、诊断包和 operation 中没有真实凭据。

Canary 不接管现有 Agent，不自动删除真实云资源。清理由用户明确批准后执行。

## 9. 全局质量门禁

Go：

```text
go generate ./...
./scripts/check-generated.sh
./scripts/scan-secrets.sh
go test ./...
go test -race ./...
go vet ./...
```

Node：

```text
npm ci --ignore-scripts --prefix bridge
npm test --prefix bridge
npm run bundle --prefix bridge
npm run build:sea --prefix bridge
npm run verify:sea --prefix bridge
```

协议与安全：

- OpenAPI lint/Validate 通过；
- Bridge protocol fixtures 双向通过；
- 真实发布物在无 Node.js 环境启动；
- 敏感值不进入 args/env/stdout/stderr/日志；
- 许可证与依赖完整性清单齐全；
- 没有新增普通消息存储或平台 WebSocket。

## 10. 实施顺序和停止条件

必须严格按任务 1→19 推进。以下情况立即停止并回到设计审查：

- 官方 Node SDK 无法在 SEA 中稳定工作；
- 必须复制腾讯私有协议才能完成基本收发；
- Runtime Credential 只能通过不受控明文持久化传递；
- OpenAPI 需要新增普通消息代理接口；
- TAT 固定模板无法阻止任意命令注入；
- 真实 Canary 需要接管现有生产 Agent。

仓库当前不是 Git 工作树，无法按任务创建提交。每个任务仍需在 `progress.md` 记录
RED/GREEN、文件和测试结果；以后初始化 Git 后再按任务边界形成提交。
