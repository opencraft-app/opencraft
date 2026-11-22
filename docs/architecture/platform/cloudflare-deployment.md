# 可选 Cloudflare 部署

[Architecture index](../README.md) · [存储端口](storage-ports.md) · [执行沙盒](../execution/execution-sandbox.md) · [Docker 三角色部署](../../../deploy/docker/README.md)

状态：目标设计，尚未实现。本页不代表任何 Cloudflare 组件已可部署。Node 自托管（Docker／systemd／Electron）始终是一等公民；Cloudflare 是部署装配选项之一，不替换 Node 路径。

## 1. 现状约束

- 现有 Docker 部署已拆为 `gateway`（准入、认证、路由）、`brain`（Codex AppServer、DSH、Pi 与任务生命周期）、`hands`（`exec-server`、终端、文件、浏览器）。
- **Codex AppServer 是原生 `codex app-server` 二进制**，DSH、Pi、ACP 也是子进程，需要 POSIX 文件系统与 PTY。它们不能在 workerd 中运行，只能在容器中运行。
- **Gateway 不是无状态的**：Codex Host 层状态（queue、schedules、中断恢复、tasks、token usage）由 Gateway 进程内的 `CodexEngineAdapter` 写入 `$DATA/codex/`。
- 账号 Core（`apps/codex-core` 的 split core 与 `packages/account-pool-host`）持有账号池、OAuth 刷新、模型代理与计量，是部署级单写者。
- 沙盒内的 Codex `exec-server`、文件、终端与浏览器 owner 全部经 stdio 传输，沙盒不需要入站端口。
- Cloudflare Sandbox SDK **不兼容 E2B API**；接入方式是实现 `@opencraft/sandbox` 端口的新后端，而不是复用 E2B SDK。`sandbox-cloudflare` 作为 `@opencraft/sandbox/providers` 的一个 provider 注册，复用 `@opencraft/sandbox/broker`（只需提供启动 broker 进程的双工通道），持久工作区通过可选 `PersistentWorkspaceProvider` 能力接入；该 provider 尚未实现。

## 2. 目标拓扑

| 组件 | 载体 | 持有 |
| --- | --- | --- |
| 边缘 Worker | Workers＋静态资源 | Web 资源、登录与 OIDC 入口、webhook 接收、WebSocket 路由到 DO、模型请求流式转发 |
| `InstallationCore` | 每部署一个 DO | 服务器核心 SQL（现由多条连接共同打开的库合并为单一 owner）、成员与授权投影、Hub 节点状态 |
| `RelayHub` | 每 installation 一个 DO | 隧道与流预算，替代 Redis 租约与节点间转发 |
| `AccountCore` | 每部署一个 DO | 账号池、加密凭据、OAuth 刷新单写者、选号与亲和、计量与策略 |
| `WorkspaceHost` | 每工作区一个 DO | Codex Host 状态（queue、schedules 以 DO alarm 实现、中断恢复、tasks、token usage）；工作区容器生命周期与连接 |
| 工作区容器 | 每工作区一个 Container，由 `WorkspaceHost` 持有 | Brain 与 Hands 同处：`codex app-server`、Pi、DSH、`exec-server`、终端、文件、浏览器；独立 `CODEX_HOME`；`/workspace` 经 R2 持久化 |

### 2.1 模型请求与凭据

工作区容器内不保存任何模型或账号凭据。引擎的模型请求由出站处理交给边缘 Worker；Worker 向 `AccountCore` 获取短期凭据租约后直接流式转发给 provider。长时间流式响应不占用 DO 运行时长，凭据只在 Worker 请求内存中短暂存在。`AccountCore` 仍是刷新与选号的唯一写入者。

协议转换（例如 Anthropic）代码需确认能在 workerd 中运行后才可迁移到 Worker。

### 2.2 工作区容器

- 镜像沿用已发布 Hands 镜像（按 digest 固定），追加 Brain 运行时；不在容器启动时下载工具。
- Brain 与执行用户使用不同 UID；凭据不进入容器文件系统。
- 容器回收或重启时，引擎进程终止；恢复沿用[中断 Turn 恢复](../execution/interrupted-turn-recovery.md)，由 `WorkspaceHost` 持有的 Host 状态驱动，不重放未确认输入。
- `CODEX_HOME` 与 `/workspace` 的持久化语义（R2 FUSE 挂载、目录备份或容器快照）需在第 5 阶段 PoC 中确定，并替换当前依赖自托管 E2B volume API 与 NFS 的持久工作区校验。

## 3. 前置工作

依赖[存储端口](storage-ports.md)第 1–4 阶段：SQL 等存储端口、沙盒 provider 泛化，以及 Gateway／Brain 按工作区拆分。这些改动先在 Node 上成立。

## 4. 待 PoC 验证

| 项 | 需确认 |
| --- | --- |
| 进程 stdin | `container.exec()` 能否在进程运行期间持续写入 stdin；否则 broker 改为容器内服务 |
| 镜像 | Hands＋Brain 镜像是否在 20 GB 上限内；是否允许任意基础镜像；架构限制 |
| 浏览器 | Chromium 沙盒在容器隔离模型下是否可用 |
| 生命周期 | 能否确认实例已销毁；能否读取实际生效 CPU／内存；休眠、重启与最长运行时间语义 |
| 持久化 | R2 FUSE／备份／快照用于 Git 工作区时的性能与一致性 |
| SQL 语义 | DO 中 `changes()`、嵌套 `transactionSync`、多语句 `exec`、`sqlite_master` 读取与 Node 一致性测试是否等价 |
| 网络 | 出站限制到边缘 Worker；Gateway 到容器的连接方式 |
| 成本 | 冷启动时间、容器常驻与 DO 时长成本 |

单实例资源上限为 4 vCPU／12 GiB／20 GB 磁盘，满足当前默认 4 vCPU／8 GiB 契约。
