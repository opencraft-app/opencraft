# acp-client

在浏览器里连接本机或远端 **ACP Agent**（如 Cursor 的 `cursor-agent acp`）的轻量网关：HTTP 静态页 + WebSocket，对齐 ACP 协议，便于在网页里对话，并把文件、终端等能力交给 Agent 处理。

## 功能概览

- **单进程网关**：Go（Gin）提供页面与 **`/ws`**，与全局单例 Agent 会话桥接。
- **多标签共享**：同一 `acp-client` 进程只维护一组 Agent stdio 会话；多个浏览器标签连上来看到的是同一会话（有意设计）。
- **队列与取消**：用户消息按 FIFO 与一轮 `session/prompt` 对应；顶栏 **停止** 图标仅在 **有待处理队列**（含「进行中 / 等待模型」或仍有排队未消费）时显示，用于取消当前轮次。
- **权限与自动授权**：可在连接时开启自动授权；否则通过页面处理 `session/request_permission`。
- **聊天记录**：按 ACP `sessionId` 落在浏览器 **localStorage**，刷新可对齐同一会话；后端也可在 `connected` 时下发事件日志用于恢复界面。
- **主题**：浅色 / 深色可切换，键名 **`acp-client-theme`**（`light` / `dark`）。

更细的分层与扩展点见 **[ARCHITECTURE.md](./ARCHITECTURE.md)**。

## 前置条件

- **Go** 1.22+
- 已安装并可执行 **`cursor-agent`**，且完成登录 / API 配置（见 [Cursor CLI · ACP](https://cursor.com/cn/docs/cli/acp)）
- 在项目仓库根目录构建与运行（依赖 `web/` 前端资源）

## 快速开始

```bash
go build -o acp-client ./cmd/acp-client
./acp-client
```

在终端输出的地址用浏览器打开（默认监听 **0.0.0.0:8765**，本机一般为 **http://127.0.0.1:8765**）。页面加载后通过 WebSocket 与后端通信；后端维护**全局单例** Agent 会话（多标签页共享同一会话）。

### Agent、刷新与聊天记录

- **Agent 子进程**在运行 `acp-client` 的那台机器上、随进程常驻**；关掉终端或结束 `acp-client` 才会结束 Agent。**只刷新浏览器**不会停 Agent；只要服务仍在且仍是同一个 ACP `sessionId`，会重新连上同一会话。
- **聊天记录**缓存在浏览器 **localStorage**：键名 **`acp-client-log:<sessionId>`**。刷新后若 `sessionId` 一致会自动还原。**「重启」** 会拿到新的 `sessionId`：界面清空，并删除上一会话对应的本地键；后端事件日志与用户时间线也会在重建 Agent 时清空。
- 离开页面前会尽量 **立即落盘**（`pagehide` / `visibilitychange`），减少「刚发完就刷新导致没写上」的情况。

### 界面与操作（简要）

- 顶栏显示连接状态（如 **已连接**）、**重启**（新会话）、**停止**（方形图标，仅在模型处理中或队列未清空时显示）、主题切换等。
- **显示/隐藏详情**：控制工具调用、思考过程等辅助信息的展示（偏好可记在 **`acp-client-hide-detail`**）。

## 命令行参数

| 参数          | 默认值            | 说明 |
|---------------|-------------------|------|
| `-listen`     | `0.0.0.0:8765`    | HTTP 监听地址。需要局域网其它设备访问时勿只绑 `127.0.0.1`。 |
| `-gin-mode`   | `debug`           | `debug` / `release` / `test`。 |
| `-web`        | `web`             | 静态资源根目录，须含 `index.html` 与 `static/`（相对当前工作目录或绝对路径）。 |
| `-password`   | *(空)*           | 访问口令；非空时启用登录页。也可设环境变量 `ACP_CLIENT_PASSWORD`（优先级低于本参数）。 |
| `-acp-url`    | `ws://101.42.117.125:8080/acp` | 远程 ACP WebSocket 服务地址。也可设环境变量 `ACP_CLIENT_URL`（优先级低于本参数）。 |

## 模型选择

不指定模型时默认使用 `auto`，前端页面可通过顶栏模型按钮弹窗切换（切换后自动重启 Agent）。

可用模型列表可通过上游 ACP 服务提供。

## HTTP 路由（摘要）

| 路径 | 说明 |
|------|------|
| `/` | 主页面（`index.html`） |
| `/assets/*` | 前端静态资源（JS/CSS 等） |
| `/ws` | WebSocket，JSON 消息体（见下节） |
| `/api/prompt_queue` | 只读队列快照 JSON（对齐调试 / 外部观测） |

其它未知 **GET** 会回退到 `index.html`（便于前端路由）；**/api/** 下未匹配路径返回 404。

## WebSocket 消息（摘要）

前端与后端通过 **`/ws`** 交换 JSON，常见 `op`：

- **`connect`**：同步工作目录、fsRoot、MCP、自动授权等；若尚无 Agent 则拉起 / 握手。
- **`chat`**：用户文本入队；忙时 FIFO，与一轮 `session/prompt` 对应。
- **`cancel`**：停止当前轮次（对应顶栏停止图标）。
- **`restart_agent`**：结束子进程并重新握手 / `session/new`。
- **`permission`**：用户对权限请求的选择（非自动授权时）。

具体字段以 `internal/handler/websocket.go` 与前端 `web/static/js/ws/session.js` 为准。

### 自定义 WebSocket 地址（反代 / 非默认路径）

默认逻辑：与当前页面 **同主机、同协议**（`https` → `wss`），路径为 **`/ws`**。若页面是 **`file://`** 打开或没有 `host`，则回退 **`ws://127.0.0.1:8765/ws`**。

部署在反向代理、子路径或独立 WS 域名时，可在 `web/index.html` 中设置：

```html
<meta name="acp-client-ws" content="wss://你的域名/ws" />
```

**反代须正确转发 WebSocket**（`Upgrade`、`Connection` 等），否则会出现连接超时或异常断开（如 close code **1006**）。

## 安全与访问控制（重要）

- 本服务**默认不对浏览器做登录鉴权**；能访问 HTTP 端口的客户端一般都能连 **`/ws`** 并驱动本机 Agent（视 `cursor-agent` 配置而定）。
- **不要将未加防护的实例暴露到公网**；若必须远程使用，请配合 VPN、SSH 隧道、或前置带鉴权与 TLS 的反向代理。
- 服务端对浏览器响应带有较宽松的 **CORS**（`*`），设计取向是本地/受信网络工具页；面向公网时请自行收紧策略。

## 常见问题

| 现象 | 可能原因与处理 |
|------|----------------|
| 一直连不上 / 超时文案里带了尝试的 WS URL | 未通过本服务提供的 **http(s)/** 打开页面（例如双击本地 **file://** HTML），或反代未转发 **WebSocket**。请用终端打印的地址访问，并检查代理配置。 |
| **1006** 异常断开 | 多为代理不支持 **Upgrade**、网络中断或中间设备断开长连接。 |
| Agent 立刻退出 / 聊天报错 | 确认远端 ACP 服务可达且已提供有效会话；若使用本机 `cursor-agent acp`，请确认本机可运行该命令且已完成 **login** 或 API 密钥配置；在运行 `acp-client` 的终端查看日志。 |
| 修改前端不生效 | 浏览器强刷或清缓存；确认 `-web` 指向你正在编辑的 `web` 目录。 |

## 日志串联（排查问题）

服务端日志使用统一前缀 **`acp-client`**。跨模块排查可在同一段日志里搜：

| 键 | 含义 |
|----|------|
| **`cid=`** | 一条 WebSocket 连接（连接到断开） |
| **`oid=`** | 一次用户 `chat` → 入队 → `session/prompt` 执行 |
| **`sid=`** | ACP `sessionId`；stdio 侧在 `session/new` 前可能为 `handshake` |
| **`pid=`** | Agent 子进程，stderr 行前缀 `agent pid=…` |

示例：先看到 `ws cid=… oid=…: chat 已入队`，再用同一 **`oid=`** 搜 `prompt … oid=` 与 `acp … Call`，即可对齐浏览器入站到 Agent RPC。

## 目录结构（简）

```
cmd/acp-client/       # 入口
pkg/
  acp/                # ACP Client SDK：JSON-RPC、Panel、fs/terminal/权限（可对外复用）
internal/
  service/            # Bridge：Agent 生命周期、WS 广播、排队与 prompt
  handler/            # HTTP / WebSocket
  router/             # Gin 路由与优雅退出
  correl/             # 短 ID 生成（日志串联）
web/                  # 前端（ESM + 静态资源）
```

> `pkg/acp` 是独立的 ACP 客户端 SDK，不依赖本仓库其它包；外部 Go 模块可直接 `import "acp-client/pkg/acp"` 复用。

## 开发与构建

```bash
go build ./...
go test ./...
go run ./cmd/acp-client -listen 127.0.0.1:8765
```

前端为原生 **ESM**，修改 `web/static/` 后刷新页面即可（无需单独打包步骤）。

### CloudAgent 真实服务 E2E

`pkg/acp` 内置 CloudAgent typed primitives 和真实 ACP server e2e。默认 `go test ./...`
不会创建云资源；显式提供 `CLOUDAGENT_ACP_E2E_URL` 后才会连接真实服务并创建 AGS/Wisp/COS runtime。

```bash
CLOUDAGENT_ACP_E2E_URL=http://127.0.0.1:18094/acp \
GATEWAY_API_KEY="$GATEWAY_API_KEY" \
go test ./pkg/acp -run TestCloudAgentLiveSessionLifecycle -count=1 -timeout 10m -v
```

恢复链路会执行 `session/close -> session/resume -> prompt`，验证 outer sandbox
销毁后仍可通过 workspace 记录重建会话：

```bash
CLOUDAGENT_ACP_E2E_URL=http://127.0.0.1:18094/acp \
CLOUDAGENT_ACP_E2E_RESTORE=1 \
GATEWAY_API_KEY="$GATEWAY_API_KEY" \
go test ./pkg/acp -run TestCloudAgentLive -count=1 -timeout 15m -v
```

可选环境变量：`CLOUDAGENT_ACP_E2E_BEARER` / `CLOUDAGENT_ACP_E2E_AUTHORIZATION`、
`CLOUDAGENT_ACP_E2E_TENANT_ID`、`CLOUDAGENT_ACP_E2E_PROJECT_ID`、
`CLOUDAGENT_ACP_E2E_CWD`、`CLOUDAGENT_ACP_E2E_AGENT_VERSION`、
`CLOUDAGENT_ACP_E2E_WORKSPACE_VERSION`、`CLOUDAGENT_ACP_E2E_TIMEOUT`。

## 参考

- [Cursor 文档 · Agent Client Protocol (ACP)](https://cursor.com/cn/docs/cli/acp)
