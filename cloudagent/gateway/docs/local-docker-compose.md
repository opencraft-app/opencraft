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

## OrbStack Local Wisp E2E

本机验证 Wisp 不走 Docker-in-Docker。Gateway 仍在 macOS 上跑，Linux runtime host 使用 OrbStack 自带的 Linux VM：

```text
gateway test process on macOS
  -> ssh orb /bin/bash -lc ...
  -> Wisp daemon + crun + JuiceFS/SMH inside OrbStack Linux
  -> outer Wisp container + inner workspace Wisp container
```

准备条件：

- OrbStack 已启动，并且 `ssh orb uname -a` 可用。
- `cloudagent/gateway/.env` 或当前 shell 提供 TokenHub、sidecar、上海 SMH/Wisp 配置；local_wisp 不需要 AGS API credential。
- OrbStack Linux 允许免交互 sudo；脚本会自动检查 `/dev/fuse`、`fsck.erofs`、`crun`、loop device。

运行：

```bash
cd cloudagent/gateway
make e2e-local-orbstack-wisp-smh
```

如果要验证本地刚构建的 Wisp 包，先在 macOS 上启动一个静态文件服务：

```bash
cd cloudagent/wisp
GOOS=linux GOARCH=amd64 WISP_PACKAGE_EROFS=1 WISP_PACKAGE_TAR_GZ=0 WISP_PACKAGE_WITH_DOCKER=1 ./hack/release/package-tarball.sh
ruby -run -e httpd "$PWD/dist-release" -p 18097
```

然后用 `host.orb.internal` 传给 OrbStack Linux：

```bash
cd cloudagent/gateway
GATEWAY_WISP_PACKAGE_URL=http://host.orb.internal:18097/wisp-linux-amd64-YYYYMMDDTHHMMSSZ.erofs \
  make e2e-local-orbstack-wisp-smh
```

实现约束：

- OrbStack 当前按主机级 Wisp daemon 跑，inner/outer 两个 Wisp container 共享同一个 daemon。
- arm64 Mac 上默认仍可使用 amd64 Wisp 包，但 container runtime 使用 OrbStack Linux 里的原生 `crun`，不要使用包内 amd64 `crun`。
- active `root-upper.img` 直接在 Wisp/JuiceFS 路径上创建；干净 VM 下 `mke2fs` 本身不是瓶颈。
- 如果手工中断过 Wisp 启动，OrbStack 里可能残留坏的 mount/loop 现场。新的 session 不应被 sibling runtime root 的旧 loop 阻断；Wisp 只会在当前 session 自己的 runtime root 上做恢复/清理。如果已经出现不可杀 D-state，重启 OrbStack VM 比脚本里强行 `umount` 更可靠。

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

## Local Wisp RuntimeHost

除 Compose 的真实 AGS 路径外，gateway 现在有一个一等本地 RuntimeHost 入口：

```bash
GATEWAY_RUNTIME_HOST=local_wisp
GATEWAY_LOCAL_RUNTIME_ROOT=/var/lib/cloudagent-local-runtime
```

这个模式的定位是 **Linux 原生 RuntimeHost**：一台 Linux host/VM 虚拟多台 AGS。不要把 Docker 当成产品运行时边界。

- gateway 仍然创建 outer 和 workspace 两个 runtime target。
- `CreateSandbox` 返回轻量本地 handle，不调用 AGS control plane。
- handle 会持久化在 `GATEWAY_LOCAL_RUNTIME_ROOT/handles/*.json`，用于恢复和排障。
- target 文件根默认在 `GATEWAY_LOCAL_RUNTIME_ROOT/targets/<target-id>`。
- `DeleteSandbox` 是幂等 bookkeeping；真正的文件系统生命周期仍由 Wisp stop/checkpoint/restore 管。
- `/readyz` 和 `/v1/selfcheck` 会按 `local_wisp` 语义检查本地 root、command prefix、Wisp/SMH 配置，不要求 AGS credential。

可选项：

```bash
GATEWAY_LOCAL_RUNTIME_COMMAND_PREFIX='ssh cloudagent-vm -- /bin/sh -lc'
GATEWAY_LOCAL_RUNTIME_ALLOW_HOST_PATHS=0
```

`local_wisp` 默认允许 host 绝对路径，因为 gateway 现有 runtime 命令会直接访问 `/tmp/gateway/...`、`/workspace`、Wisp rootfs 等路径；如果 upload/download 被重写到 target root，而命令仍访问真实绝对路径，文件会不可见。只有在纯单测或受控实验里，才建议把 `GATEWAY_LOCAL_RUNTIME_ALLOW_HOST_PATHS=0` 打开，让文件 API 限制在 target root 下。

正常设计里 gateway 本身跑在 Linux 上，可以不配 prefix，命令直接在 gateway host 上执行。`GATEWAY_LOCAL_RUNTIME_COMMAND_PREFIX` 只用于非 Linux 开发机把命令代理到 Linux VM，例如 OrbStack machine 或 SSH；它不是生产设计的一部分。

验证本地 Linux runner：

```bash
make e2e-local-runtime-host
```

这个目标默认要求在 Linux 上运行。它会断言 runtime 命令返回 `Linux`，验证 host 上传的文件能在 Linux runtime 的同一路径读到，并锁定 timeout/cancel 不泄漏远端子进程。

如果使用已有 Linux VM，需要确保 `CLOUDAGENT_LOCAL_LINUX_SHARED_ROOT` 在 host 和 VM 中是同一个共享路径：

```bash
CLOUDAGENT_LOCAL_LINUX_COMMAND_PREFIX='ssh cloudagent-vm' \
CLOUDAGENT_LOCAL_LINUX_SHARED_ROOT=/mnt/cloudagent-local-runtime \
make e2e-local-runtime-host
```

如果确实要在非 Linux 开发机上临时用 Docker 做兼容 runner，必须显式打开：

```bash
CLOUDAGENT_LOCAL_RUNTIME_HOST_DOCKER=1 make e2e-local-runtime-host
```

这只用于本地兼容验证，不代表 CloudAgent runtime 设计依赖 Docker。

验证真实上海 SMH + Wisp + 本地 Docker：

```bash
make e2e-local-docker-wisp-smh
```

这个目标不是 fake runtime。Docker 只提供本地 Linux 计算环境；Wisp package、SMH space/token、outer Wisp、workspace Wisp 都走真实上海配置。脚本会启动一个 privileged `linux/amd64` Debian 容器，设置 `GATEWAY_RUNTIME_HOST=local_wisp`，然后跑 `TestLiveLocalDockerWispSMHRuntime`：

- 创建 outer local runtime target。
- 创建 workspace local runtime target。
- 创建真实 SMH space。
- 在 Docker Linux 内 prepare outer/inner 两份 Wisp。
- 启动 sidecar daemon 并绑定 workspace runtime。
- 刷新 runtime。
- close 两份 Wisp 并要求 checkpoint/stop 成功。

必需配置：

```bash
GATEWAY_AGENT_SIDECAR_URL=...
GATEWAY_WISP_SMH_LIBRARY_SECRET=...
```

默认会使用上海 SMH library：

```text
GATEWAY_WISP_SMH_LIBRARY_ID=smh37laghvp09llc
GATEWAY_WISP_SMH_ACCESS_DOMAIN=https://smh37laghvp09llc.ap-shanghai.api.tencentsmh.cn
```

在 macOS 上更推荐直接用 OrbStack Linux machine 作为 RuntimeHost，而不是在 Docker 容器里再跑 Wisp 的 `crun`：

```bash
make e2e-local-orbstack-wisp-smh
```

这个目标通过 `ssh orb /bin/bash -lc` 执行 runtime 命令，Mac 仍然跑 gateway/test controller，OrbStack machine 负责真实 Linux runtime：

- 不再嵌套 `crun in Docker`。
- 继续使用真实上海 SMH library、SMH token、Wisp package。
- outer Wisp 和 workspace Wisp 在同一台 OrbStack VM 上启动，当前共享同一个主机级 Wisp daemon。Wisp daemon 不是按端口多实例模型；不要为了 inner/outer 强行起两个 daemon。
- 默认复用上海 `linux-amd64` EROFS package，并依赖 OrbStack/Rosetta 的 amd64 ELF 支持；如果后续发布 `linux-arm64` Wisp package，可通过 `GATEWAY_WISP_PACKAGE_URL` 和 `GATEWAY_WISP_PACKAGE_ARCH=arm64` 切换。

必需配置同 Docker 目标：

```bash
GATEWAY_AGENT_SIDECAR_URL=...
GATEWAY_WISP_SMH_LIBRARY_SECRET=...
```

如果 OrbStack SSH target 不是默认 `orb`：

```bash
CLOUDAGENT_ORBSTACK_SSH_TARGET=root@orb make e2e-local-orbstack-wisp-smh
```
