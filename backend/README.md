# Chatserver Platform v1

本目录描述一个以腾讯云为基础设施的 Human/Agent 协作平台。

## 核心边界

```text
腾讯云 IM  = Human 与 Agent 的聊天数据面
Vela Assignment = Agent Runtime 的期望状态与执行面
腾讯云 TAT = Computer 纳管与 PTY 执行面
Go 后台    = 产品、权限和业务事实控制面
SQLite     = 单机生产模式的业务存储
TDSQL      = 水平扩展模式、按 Account/Server Group-Shard 的业务存储
```

- Human 与 Agent 都是腾讯云 IM 普通用户，都直接连接腾讯云 IM；
- 腾讯云 IM 保存普通消息、历史、未读、附件并负责长连接正确性；
- Computer 只使用 TAT 原生实例或 `rins-*` 托管实例；
- 腾讯云原生实例与托管实例使用完全相同的 TAT 命令和 `StartSession` PTY；
- Go 后台不代理聊天、不保存聊天历史、不运行 Computer WebSocket；
- Task、Reminder 等业务事实保存在平台数据库，IM 自定义消息只负责唤醒 Agent；
- 后台持有平台级腾讯云凭证，用户、浏览器和 Agent 不持有管理员密钥。

## v1 范围

```text
一个生产环境
├── 一个腾讯云 IM SDKAppID
├── 一套平台级腾讯云凭证
├── 多个 Server
│   ├── Human / Agent Member
│   ├── Community / Topic
│   ├── Computer（TAT 实例）
│   ├── Agent Runtime
│   └── Task / Reminder
└── macOS ARM64 managed Computer、可通过直连或代理出网
```

macOS 使用当前用户级 LaunchAgent 安装，不需要 Root。Linux/Windows、离线网络、多云
Provider 抽象、自研 Computer WebSocket 和系统级特权安装均不在 v1 范围内。腾讯云资源
配额可以按业务增长申请提升，不作为 v1 领域模型。

## 规格

- `platform/v1/01-产品范围.md`
- `platform/v1/02-领域模型.md`
- `platform/v1/03-状态机与事务.md`
- `platform/v1/04-数据库规格.md`
- `platform/v1/05-HTTP-API设计.md`
- `platform/v1/06-TAT执行面.md`
- `platform/v1/07-腾讯云IM适配.md`
- `platform/v1/08-内部任务契约.md`
- `platform/v1/09-权限与错误契约.md`
- `platform/v1/10-TDSQL分区与路由.md`
- `platform/v1/11-SQLite数据基础实施设计.md`
- `platform/v1/12-SQLite数据基础实施计划.md`
- `platform/v1/13-Go后台应用层架构设计.md`
- `platform/v1/14-Go后台应用层基础实施计划.md`
- `platform/v1/17-Human-IM身份实施计划.md`
- `platform/v1/18-Server-Member与Community实施设计.md`
- `platform/v1/19-Server-Member与Community实施计划.md`
- `platform/v1/20-Vela正式AgentHost收敛.md`
- `platform/v1/22-Agent在线投影.md`
- `platform/v1/openapi.yaml`

平台没有自有 WebSocket/Socket.IO 服务，因此不再提供 AsyncAPI。

## 当前实现

首个 Go 后台切片已经包含：

- 26 张业务表的 Ent Schema 与生成代码；
- SQLite 单机生产连接、进程级单 Writer 锁和统一事务；
- 内嵌 Atlas 版本化 migration、状态读取和 Schema 校验；
- UUIDv7 逻辑主键与未来 TDSQL 使用的 ShardKey 元数据；
- `database migrate/status/verify` 运维命令；
- 邮箱密码注册、登录、Access/Refresh Token 轮换和退出；
- Argon2id 密码摘要、HS256 JWT、refresh token 摘要/单次轮换与重放撤销；
- 注册时可靠创建 Human IM 身份 TencentOperation 与 Outbox；
- `im.identity.ensure` SQLite Worker、短租约、重试和旧 lease fencing；
- 腾讯云 IM `account_import` 真实 REST Adapter；
- 稳定、不含个人信息的 Human IM UserID 派生与持久化；
- `GET /v1/me` 与 `POST /v1/me/im/session`；
- 基于腾讯官方 HMAC-SHA256 实现的服务端短期 UserSig；
- OpenAPI 校验、统一错误、敏感响应头与本地认证限流；
- 显式 `serve` API+IM Worker 单进程启动命令。
- 正式 `raft-computer-go daemon run` Host 已支持 Codex、Hermes ACP 与
  Hermes Gateway；
- Agent 直接登录腾讯云 IM，按 `replyPolicy` 过滤消息并按会话保序；
- Runtime 只有显式调用 `raft message reply --text <text>` 才会发出聊天消息；
- 输入处理账本与发送动作账本均不保存正文，发送结果不确定时禁止自动重放；
- Human 可经平台签发一次性 TAT PTY Session，终端字节流不经过 Go 后台。

当前只启用 SQLite 运行模式。`serve` 已暴露 Auth/Me、Server/Member/Invite、
Channel、Thread 引用、Computer、Agent、Task/Reminder/Inbox、Operation 和 Runtime 管理面；
TAT Terminal Session 仅在配置内部 Issuer Gateway 后可用。聊天消息仍只经过腾讯云
IM，不进入这些平台 HTTP 接口或 SQLite。

## 数据库命令

默认数据库位于系统用户配置目录的 `chatserver/chatserver.db`。生产环境建议显式设置
`CHATSERVER_DATABASE_PATH`，值必须是绝对路径。

```text
go run ./cmd/chatserver database migrate
go run ./cmd/chatserver database status
go run ./cmd/chatserver database verify
```

也可以为单次命令指定路径：

```text
go run ./cmd/chatserver database migrate --database /absolute/path/chatserver.db
```

## 启动平台 API 与 Human IM Worker

先生成相互独立的 JWT HMAC 密钥、稳定 IM UserID 派生密钥和腾讯 IM 回调 Token：

```text
openssl rand -base64 32 > /安全目录/chatserver-jwt.key
openssl rand -base64 32 > /安全目录/chatserver-im-identity.key
openssl rand -base64 32 > /安全目录/tencent-im-callback.token
chmod 600 /安全目录/chatserver-jwt.key /安全目录/chatserver-im-identity.key \
  /安全目录/tencent-im-callback.token
```

再把腾讯云 IM 控制台对应 SDKAppID 的 SecretKey 写入独立安全文件并设置权限：

```text
chmod 600 /安全目录/tencent-im-secret.key
```

SecretKey 不得写入命令行、环境日志、源码或数据库。IM 身份派生密钥也必须长期稳定；
它与腾讯 SecretKey 分离，腾讯密钥轮换不会改变已有 UserID。

然后启动仅回环监听的平台 API 与 IM Worker；启动时会自动迁移并核验 SQLite：

```text
go run ./cmd/chatserver serve \
  --jwt-key-file /安全目录/chatserver-jwt.key \
  --im-sdk-app-id 你的SDKAppID \
  --im-admin-user-id 你的IM管理员UserID \
  --im-secret-key-file /安全目录/tencent-im-secret.key \
  --im-identity-key-file /安全目录/chatserver-im-identity.key \
  --im-callback-token-file /安全目录/tencent-im-callback.token \
  --database /absolute/path/chatserver.db \
  --listen 127.0.0.1:8080
```

在腾讯云 IM 控制台把状态变更回调配置为公网 HTTPS 地址
`/v1/callbacks/tencent-im/state`，Token 必须与上面的独立文件一致。未配置该参数时
回调路由不会注册，其他平台能力仍可运行。

如需开放 TAT PTY，会话签发 Gateway 地址与服务令牌必须成对配置：

```text
--tat-session-issuer-url https://内部签发服务/v1
--tat-session-token-file /安全目录/tat-session-issuer.token
```

未配置时普通平台与 IM 能力仍可运行，但终端会话接口会返回明确的
`terminal_session_unavailable`。

## Agent 自动回复

用户级 LaunchAgent 只启动一个 `raft-computer-go daemon run`。daemon 通过平台 HTTPS
长轮询 Computer Assignment，在同一进程内为多个 Agent 创建 RuntimeActor；每个 Agent
使用自己的短期 Runtime Session 和 UserSig，通过内嵌 LiteChat 直连腾讯云 IM。

模型进程得到的 `raft` 是共享回环 Gateway 生成的本地 wrapper，没有腾讯云管理密钥，
也不能自行选择其他 Agent 的身份。当前完整 Runtime 为 `codex`、`hermes-acp` 与
`hermes-gateway`。Chatserver 不包含第二套 Agent Host、IM Bridge 或 TAT receiver。

中国区域默认调用 `https://console.tim.qq.com`。本地集成测试可用
`--im-rest-base-url` 指向回环测试服务器，生产不应改成明文 HTTP。

## Computer 不可变发布

macOS Computer 使用当前用户安装：程序位于 `~/.vela/bin`，持久状态位于
`~/.vela/state`，Agent 工作区位于 `~/.vela/workspaces/<agentID>`；服务配置位于
`~/Library/LaunchAgents`。安装命令不执行 `sudo`、不写 `/Library`；用户登录后由
LaunchAgent 自动运行，退出登录后停止。

发布私钥只保存在发布工作站，不进入仓库、COS、容器或 Kubernetes。先在权限为 `0700`
的仓库外目录生成不可覆盖的 Ed25519 密钥：

```text
go run ./cmd/computer-release keygen \
  --key-id computer-release-2026-08-02 \
  --private-key-file /安全目录/ed25519.private \
  --public-key-file /安全目录/ed25519.public
```

构建后必须用独立公钥重新验证 catalog、四个制品摘要和 manifest 签名：

```text
# 在 canonical go-client 工程中构建已静态链接 TAT 的唯一端侧程序
./scripts/build-vela-macos-arm64.sh \
  --version v0.1.1 \
  --output /绝对路径/raft-computer-go

go run ./cmd/computer-release \
  --version v0.1.1 --target darwin-arm64 \
  --os-type macos --architecture arm64 \
  --signing-key-id computer-release-2026-08-02 \
  --private-key-file /安全目录/ed25519.private \
  --program /绝对路径/raft-computer-go \
  --output /全新绝对路径/release

go run ./cmd/computer-release verify \
  --release-directory /全新绝对路径/release \
  --public-key-file /安全目录/ed25519.public
```

COS 发布凭据也只通过 `0600` 文件传入。正式上传使用 `--publish`、私有桶和地域参数；
Publisher 会禁止覆盖同名版本，并在上传后重新下载真实字节核对大小与 SHA-256。只有远端
验真成功后，才能把 `release.catalog.json` 挂载给后台并启用安装命令。

浏览器开发环境可重复指定明确的 Origin，不支持通配符：

```text
--cors-origin http://localhost:3000
```

开发质量检查：

```text
go generate ./...
./scripts/check-generated.sh
./scripts/scan-secrets.sh
go test ./...
go test -race ./...
go vet ./...
```
