# Local Docker Compose

本文档说明如何把 `cloudagent/gateway` 在本机用 Docker Compose 跑成每个开发者都能复用的真实 AGS 测试环境。

## 目标

Compose 只保留一种运行方式：`GATEWAY_WORKER_MODE=agent_injected`。

这意味着本地环境会走真实 CloudAgent gateway 链路：

1. 浏览器或 ACP client 连接本地 gateway。
2. gateway 创建外层 AGS sandbox。
3. 外层 sandbox 下载并启动 CloudAgent sidecar。
4. sidecar 在需要文件、shell、工具能力时创建内层 AGS sandbox。
5. 如果启用 Wisp，outer/inner runtime 使用 Wisp workspace 做持久化和恢复。

不再提供 fake worker 作为 Compose 默认路径。需要无云依赖的快速协议测试时，继续使用 Go 单测或 `make e2e-session-run-lease-multiprocess`。

## 准备环境文件

复制模板：

```bash
cd cloudagent/gateway
cp compose.agent.env.example .env.compose.local
```

填写 `.env.compose.local`：

```bash
GATEWAY_API_KEY=local-dev-key
GATEWAY_DEFAULT_TENANT_ID=tenant-local
GATEWAY_DEFAULT_PROJECT_ID=project-local

E2B_DOMAIN=ap-shanghai.tencentags.com
E2B_API_KEY=...
TOKENHUB_API_KEY=...
TOKENHUB_MODEL=minimax-m2.7

GATEWAY_AGS_TEMPLATE=sdt-...
INNER_SANDBOX_TEMPLATE=sdt-...

GATEWAY_AGENT_OUTER_RUNTIME=wisp
GATEWAY_AGENT_SIDECAR_URL=https://...
GATEWAY_AGENT_SIDECAR_SHA256=...
GATEWAY_SANDBOX_HOST_URL=https://...
GATEWAY_SANDBOX_HOST_SHA256=...
GATEWAY_WISP_PACKAGE_URL=https://...
GATEWAY_WISP_SMH_LIBRARY_ID=...
GATEWAY_WISP_SMH_ACCESS_DOMAIN=https://...
GATEWAY_WISP_SMH_LIBRARY_SECRET=...
```

`.env.compose.local` 已被 git ignore。不要提交，也不要把 `docker compose config` 的完整输出贴到公开日志里；Compose 会展开 env file 里的密钥值。

如果你的 env 文件放在别处，可以这样指定：

```bash
CLOUDAGENT_GATEWAY_ENV_FILE=/path/to/cloudagent-gateway.env docker compose up --build gateway-a
```

## 启动 Gateway

```bash
cd cloudagent/gateway
docker compose up --build gateway-a
```

或者：

```bash
make compose-up
```

服务启动后验证：

```bash
curl -fsS http://127.0.0.1:18094/healthz
curl -fsS http://127.0.0.1:18094/v1/models \
  -H 'Authorization: Bearer local-dev-key'
```

默认端口：

- Gateway A: `http://127.0.0.1:18094`
- Gateway B: `http://127.0.0.1:18095`，只在 `multi` profile 下启动
- MyChat: `http://127.0.0.1:5173`，只在 `ui` profile 下启动

## 启动 MyChat

```bash
cd cloudagent/gateway
docker compose --profile ui up --build gateway-a mychat
```

或者：

```bash
make compose-up-ui
```

打开：

```text
http://127.0.0.1:5173/?acp_url=http%3A%2F%2F127.0.0.1%3A18094%2Facp
```

这里的 `acp_url` 指向宿主机端口 `18094`。浏览器运行在宿主机上，所以不要写 compose 内部服务名 `gateway-a:8080`。

## 双 Gateway 本地环境

多进程 ownership 场景使用两个 gateway 容器，共享同一个 Docker volume 里的 SQLite store：

```bash
cd cloudagent/gateway
docker compose --profile multi up --build gateway-a gateway-b
```

或者：

```bash
make compose-up-multi
```

这个模式用于本地复现“两个 gateway 进程竞争同一个 ACP session”的行为。注意：

- 这会启动两套真实 gateway，都具备创建 AGS 的能力。
- 它仍是单机共享 SQLite 模型，不等价于生产多节点分布式锁。
- 如果你不是在验证 ownership 竞争，日常只启动 `gateway-a`。
- 后续如果引入 Redis lease store，Compose 环境应把 Redis 也纳入同一套拓扑。

## 数据目录和重置

Gateway 数据放在 Docker volume `cloudagent-gateway_gateway-data`，容器内路径为：

```text
/data/gateway/wrapper.db
```

停止但保留数据：

```bash
docker compose down --remove-orphans
```

彻底重置本地 session、文件、runtime store：

```bash
docker compose down -v --remove-orphans
```

Makefile 的默认停止命令不会删除 volume：

```bash
make compose-down
```

## 日志

查看 gateway 日志：

```bash
docker compose logs -f gateway-a
```

查看双 gateway 日志：

```bash
docker compose --profile multi logs -f gateway-a gateway-b
```

常用信号：

- `gateway.listening`: 进程已启动并监听。
- `sidecar_download_start` / `sidecar_download_done`: 外层 AGS 开始/完成下载 sidecar。
- `runtime ownership`: session run lease 抢占、续租、拒绝。
- `workspace_runtime_shutdown` / `inner_shutdown`: 内外 runtime 关闭过程。
- `restore_failed` / `runtime_not_recovered`: runtime 恢复失败，先看同一时间的 ownership 和 Wisp/AGS 错误。

## 常见问题

### env file 缺失

如果看到 `.env.compose.local` 不存在，先复制模板：

```bash
cp compose.agent.env.example .env.compose.local
```

### 端口被占用

覆盖宿主机端口：

```bash
GATEWAY_A_PORT=18194 docker compose up --build gateway-a
```

MyChat 地址也可以覆盖：

```bash
MYCHAT_PORT=15173 docker compose --profile ui up --build gateway-a mychat
```

### MyChat 能打开但连不上 ACP

确认 URL 使用 `/acp`：

```text
http://127.0.0.1:5173/?acp_url=http%3A%2F%2F127.0.0.1%3A18094%2Facp
```

再确认 gateway 可达：

```bash
curl -fsS http://127.0.0.1:18094/healthz
```

### Gateway 启动失败

先确认 `.env.compose.local` 里必需项都已经传入：

- `E2B_API_KEY`
- `TOKENHUB_API_KEY`
- `GATEWAY_AGS_TEMPLATE`
- `INNER_SANDBOX_TEMPLATE`
- `GATEWAY_AGENT_SIDECAR_URL`
- `GATEWAY_AGENT_SIDECAR_SHA256`

如果启用 Wisp，还需要：

- `GATEWAY_AGENT_OUTER_RUNTIME=wisp`
- `GATEWAY_WISP_PACKAGE_URL`
- `GATEWAY_WISP_SMH_LIBRARY_ID`
- `GATEWAY_WISP_SMH_ACCESS_DOMAIN`
- `GATEWAY_WISP_SMH_LIBRARY_SECRET`

### Compose build 慢

Gateway 镜像只构建 Go server，不构建 Rust sidecar。慢通常来自首次拉 `golang:1.22-bookworm` 或 `node:22-bookworm-slim`。后续会走 Docker layer cache。

## 和现有 e2e 的关系

Compose 环境的定位是给每个开发者提供长期可用的真实 AGS 手工测试面。

自动化断言仍优先使用现有 e2e：

```bash
make e2e-agent-sidecar
make e2e-session-run-lease-multiprocess
```

其中 `make e2e-session-run-lease-multiprocess` 会在宿主机上临时启动两个 gateway 进程、创建临时 SQLite store，并自动断言：

- runtime refresh 会续租 SessionRunLease。
- `session/close` 会释放 SessionRunLease。
- WebSocket `session/load` 后断开不会释放 SessionRunLease。
- 并发 `_cloudagent.runtime.ensure_ready` 只有一个 owner 成功。
