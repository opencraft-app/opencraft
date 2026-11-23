# 服务器 Codex 核心服务

服务器可显式启用 `@opencraft/codex-core`。默认兼容形态将 `codex app-server`、账户池代理、登录、凭据刷新与用量维护放在同一个独立长驻进程中；显式拆分形态把 APP Server 移至另一个独立 unit，账号 Core 可以单独升级。执行网关和 daemon 只持客户端连接。关闭最后一个页面、关闭 daemon 或重启执行侧不终止所选常驻执行 owner 中的活动轮次、shell 工具、原生 queue 与 goal。

桌面端默认继续使用 daemon 内嵌 stdio 模式。没有 `--codex-core-endpoint` 时不会探测或启动核心服务。服务器执行更新可接入[受管更新器](../../operations/web-deployment.md#服务器执行端更新)，只切换网关、daemon 和 capability adapter，保持 core 与 CLI 运行。网页/网关发布不等待 Core 更新、目标完成或账户源码同步；两者分别报告实际版本。Codex 多代会话分配、候选准备与 CAS 切换已经实现，详见[代升级契约](../../operations/full-upgrade-generations.md)；DSH 宿主自身平滑升级仍属后续设计。

## 所有权与协议

- 账号 Core 是 Codex 数据目录内 `account-pool.sqlite`、`secrets/`、`login/`、`refresh/` 的业务 owner；`runtime/` 的唯一运行时 owner 是所选形态中的 APP Server。daemon 远程模式不打开这些目录。
- CLI 的 `CODEX_HOME` 是 `<data-directory>/runtime`，工作 cwd 来自显式 `--runtime-directory`。CLI 只收到回环代理 URL 和 synthetic Host token；真实账户凭据由代理读取。兼容模式的代理端口在 Core 生命周期内稳定；拆分模式显式固定 loopback 代理端口，持久 Host token 跨 Core 重启稳定。
- 原生入口为 `codex app-server --listen unix://...`。Unix socket 使用 WebSocket HTTP Upgrade，连接各自 initialize，不能当 JSONL 使用。每个 daemon adapter 持一个原生连接，负责 logical client 与请求 ID 映射。同一连接上的逻辑订阅计数，最后订阅者离开才发送 native unsubscribe。
- `GET /health` 与 `POST /accounts` 位于独立 Unix HTTP 控制 socket；后者接受 `{method, params}`，仅转发 `opencraft/codex/accounts/*`。两者要求 `Authorization: Bearer <daemon token>`，与 daemon 共用私有 token 文件。无远程 shutdown 接口。
- socket 目录必须为 0700，控制与原生 socket 均为 0600；原生 listener 依靠 Unix 文件权限限制访问。CLI 可能把原生路径建为符号链接，验收应使用 `stat -L` 检查实际 socket，不能把符号链接自身的 0777 当作目标权限。不要将原生 socket 通过公开网关暴露。
- 健康检查返回协议版本、core PID、所选 Codex 子进程 PID 与原生 socket。官方 npm CLI 可能有 Node wrapper，部署验收还须记录其实际 native 子进程 PID，不能只比较 wrapper。
- 执行 ENV 投递（[launch delivery 第 7 片](environment-launch-delivery.md#slices)）的接收方是拆分形态中持有 `codex app-server` 的 APP Server 进程：`--environment-launch-config` 固定签发方公钥、本 owner 的 attachment 与服务器数据目录。公钥是 vault owner 加密保存在 vault 中的稳定签发密钥，只来自其属主私有发布文件，不来自网关或请求（[Supervisor wiring](environment-launch-delivery.md#supervisor-wiring)）：容器中 Brain 的 workspace-agent（`brain` 角色）先于网关启动，把该公钥、`server:<machine>:codex`、Brain 包内 `runtime/execution-admission-worker.mjs` 与数据目录写入容器私有 run 目录（`OPENCRAFT_AGENT_RUN_DIR`）的 `codex-app-server-environment.json` 并传给 APP Server，发布变化（首次启用或显式轮换）时经 agent supervisor 退役并重启 Pi、DSH 与 APP Server（不计为关键子进程失败，后继未就绪则结束 agent）；systemd 下配置写 `environmentIssuerFile`，APP Server 启动时按同一规则读取，由 issuer path unit 重启。发布缺失或被拒绝时固定一把无人能签发的公钥，投递失败关闭；网关重启或更新不改变公钥，也不重启 APP Server。daemon 只转发不透明 capsule 与记录定位符；APP Server 在自身 Worker 中读取持久准入（待提交 Codex 输入的 lease 或 Server 的创建预留），打开 capsule 后经 `shell_environment_policy.set` 写入原生 Thread，并在转发原生错误前脱敏。组合形态与多代路由形态没有接收方，配置投递时失败关闭。
- 核心服务不可用时 daemon 明确失败，不创建第二个 writer，不重放结果未知的 mutation。Host overlay 主动重连并核对原生执行状态；已确认被打断的任务按[恢复策略](interrupted-turn-recovery.md)系统续跑，不依赖页面点击继续。
- 设备码授权由核心服务的独立维护 CLI 等待上游结果；成功通知直接触发一次入池与额度刷新，不依赖网页继续 poll。网页返回或重载通过账户列表恢复已完成账号，原页面的短期完成回执可重复查询；pending 会话不跨 core 重启恢复；启动时先由同一账户owner恢复临时profile内原生已写出的可复用授权，全部提交后才清理，存储失败保留文件以便重试。授权完成中的入池先排空，再关闭用量维护和存储。
- 兼容模式正常维护关闭时先结束 CLI；拆分模式不向 APP Server 发送信号。两种形态均等待账户 RPC、用量维护和代理已接收请求的异步处理结束，最后关闭存储并释放 writer 锁。HTTP 断连不等于其 OAuth 刷新已完成；刷新中的新凭据仍须落盘。

数据目录使用持有式 SQLite EXCLUSIVE 事务作为启动互斥，随持有进程退出由内核释放。`.codex-writer.sqlite` 保护账号 owner，`.codex-runtime.sqlite` 保护 APP Server；兼容 Core 和内嵌模式获取两把锁，拆分模式各取一把。Linux 启动运行时 owner 时还检查已有 `app-server` 进程的实际 `CODEX_HOME`，拒绝旧版内嵌或孤儿子进程仍占用相同目录的情况。不要删除活进程的锁文件来强行启动第二份服务；旧版迁移必须先停旧 writer。

## 账户积分策略

账户详情中的“允许使用积分”由账户池唯一 owner 持久化为 `allowCredits`，经
`opencraft/codex/accounts/setAllowCredits` 更新，列表返回权威值。新账户默认关闭；
升级前已存在的账户保留原先允许使用积分的行为，可逐个关闭。旧 Host 未返回该字段时，
控件禁用并说明暂不支持，不能把前端选择当作服务端策略。

关闭时任一有效订阅窗口已使用至少 98% 就不再选择该账户；开启且服务端确认积分可用时，
即使订阅窗口已使用 100% 也可继续选择。实际拒绝会撤销积分准入，开关不能覆盖拒绝、
认证错误或停用。策略同时决定状态投影及既有会话的后续请求准入，不中止正在执行的请求，
不改变真实用量百分比，不使用重置券。该偏好与上游报告的积分可用事实分别存储。

## 构建与启动

在当前 checkout 安装依赖并构建：

```sh
npm ci
npm run build --workspace @opencraft/codex-core --workspace @opencraft/opencraft-daemon
```

将 core bundle 放到独立安装目录，普通执行侧构建不得覆盖或重启它。以下部署模板的路径和用户需按现场填写；不要把私有 token 写入 unit 或命令行。

```ini
[Unit]
Description=OpenCraft Codex Core
After=network.target

[Service]
Type=simple
User=opencraft
RuntimeDirectory=opencraft-codex-core
RuntimeDirectoryMode=0700
UMask=0077
WorkingDirectory=/srv/opencraft
ExecStart=/usr/bin/node /opt/opencraft/codex-core/main.cjs --endpoint /run/opencraft-codex-core/control.sock --token-file /var/lib/opencraft/daemon.token --codex-executable /usr/local/bin/codex --runtime-directory /srv/opencraft --data-directory /var/lib/opencraft/codex --native-codex-home-directory /var/lib/opencraft/native-codex
Restart=on-failure
RestartSec=3
KillMode=control-group
TimeoutStopSec=150

[Install]
WantedBy=multi-user.target
```

执行侧 unit 只使用 `Wants=opencraft-codex-core.service` 与 `After=opencraft-codex-core.service`，不得使用 `PartOf` 或 `BindsTo`。两者有独立 cgroup。执行侧启动 daemon 时增加：

```text
--codex-core-endpoint /run/opencraft-codex-core/control.sock
```

使用 `OpenCraftDaemonClientManager` 的网关设置 `codexCoreEndpoint`，其余 daemon 参数不变；daemon 从既有 `OPENCRAFT_DAEMON_AUTH_TOKEN` 取得相同 token。首次启动前 token 文件必须已存在，保持 0600。不更改 Caddy、Nginx 或页面认证。

## 容器部署中的独立模型代理（proxy）

容器部署（`deploy/docker/compose.yaml`）默认由独立的 `proxy` 服务运行拆分形态的账号 Core（`codex-core.cjs`），Brain 不再内嵌它。`compose.proxy.yaml` 已退役为空叠加文件，仅为兼容旧命令保留。

- `proxy` 使用同一镜像，入口 `container-service.mjs proxy`，以固定 `OPENCRAFT_PROXY_PORT`（默认 45071）启动账号 Core；参数与 Brain 内嵌时完全一致（`scripts/container-deployment/proxy-core.mjs` 单一定义）。健康检查只看账号 owner 处于 `open`（`GET /owner-handoff`），不依赖 Brain 的 APP Server，因此可先于 Brain 启动。
- Brain 设置 `OPENCRAFT_PROXY_MODE=external` 与相同端口：只等待 proxy 就绪，不再启动或停止账号 Core；APP Server 继续通过控制 socket 取得代理地址与 Host token。
- 结果：Brain 发布不重启代理与账号存储；proxy 发布只排空代理已接收的请求（`stop_grace_period` 150s），不重启引擎。代理重启期间新的模型请求会失败，按既有重试边界处理，不重放结果未知的 mutation。调用者令牌与端口稳定，引擎无需重启即可恢复。
- 非 Compose 启动（未设置 external）时 `host.mjs` 仍内嵌账号 Core，与之前等价。

**Brain 不持有模型凭据。** proxy 模式下 Pi 与 DSH 的组合根（`engineModelCredentials`，`apps/local-agent-host/src/model-config/engine-credentials.ts`）不构造任何指向 `models/credentials.json` 的 SecretStore，而是得到 `ProxyModelCredentials`：写入与"是否已配置"经代理 `POST /model-credentials`（仅 `caller:pi`／`caller:dsh` 令牌）交给账号 Core 保存，没有读回接口，`resolve` 一律拒绝。执行投影 `proxyProjection` 把每个 provider 分为三类：经代理（Anthropic Messages、OpenAI Responses、OpenAI 兼容 Chat Completions，需明确的 HTTPS 或本机地址；代理按原生协议转发 `/providers/{id}/…`，Chat Completions 不进入 Codex 目录）、无需引擎凭据（免鉴权、人类订阅／贡献由 Core 处理、语音由 Gateway 处理）、拒绝（目录默认端点、其他协议、明文 LAN 地址）。拒绝类在保存时以用户可读原因失败；切换前已保存且未修改的此类 provider 保留在文档中，但不进入执行投影，绝不回退为直连。Pi／DSH 的 owner handoff 冷读在该模式下也跳过 `credentials.json`。图像生成、语音转写、IM 渠道与个人助理运行在 Gateway，凭据仍由 Gateway 持有。

既有部署切换到独立 proxy 属于维护操作：账号 writer 锁由内嵌 Core 持有，必须先停止 Brain（会中断其中的活动轮次），再启动 proxy，最后以 external 模式启动 Brain。`compose-release.mjs` 按 `hands`、`proxy`、`brain`、`gateway` 顺序应用，并在发现 Brain 未设置 external 时先停止 Brain。回退：停止 Gateway、Brain 与 proxy，用上一版本的 Compose 文件与镜像启动。数据目录与 schema 不变。详见 [Docker 部署](../../../deploy/docker/README.md#model-proxy)。

## 切换、升级与回退

首次切换在隔离验收通过后进行：确认部署工作区空闲、旧 Codex 无加载/活动会话；备份执行网关、daemon bundle、unit 与私有 Codex 数据。停止旧 writer 后，核心服务才能打开原目录。切换执行网关参数并启动独立 unit，核对两条 `runtime/machine/read`、模型菜单两组及健康状态。再次重启执行侧，比较 core、wrapper 和 native PID，并在页面重连后检查 Codex 可用。

**未拆分形态下，升级 CLI、核心服务或账户代理代码需要重启 core，会中断正在运行的 Codex 任务。拆分形态只有 APP Server/CLI 自身维护需要排空原生任务；账号 Core 更新按下方独立流程排空代理请求。** 本方案把它们移出普通执行侧升级范围。当前原生协议没有完整 drain 事务；维护前检查活动轮次、工具、queue、goal、待审批与账户维护。不得为维护隐式暂停 goal 或批准请求。持续活动无法自然清空时需由操作者明确安排暂停/取消。不宣称跨 CLI 版本兼容或 APP Server crash 后原地续跑。Core crash 的原生流重试与 APP Server crash 的轮次恢复是不同边界。

回退内嵌模式同样需要维护窗口：先停止执行侧、停止并禁用 core，确认 native writer 退出，再恢复备份的网关参数和 daemon bundle，移除执行侧 core 依赖并启动执行侧。通常保留当前数据，不自动用旧备份覆盖新会话或账户变更。具体备份和回退脚本属于部署记录，不提交机器路径或凭据。

## 验证

```sh
npm run typecheck --workspace @opencraft/codex-core --workspace @opencraft/opencraft-daemon --workspace @opencraft/account-pool-host --workspace @opencraft/desktop
npm run test:appserver
npm run test:codex-core
npm run check:boundaries
```

核心测试覆盖账户控制鉴权与转发、零连接生命周期、重复 writer 拒绝、远程不可用不回退、同连接多逻辑订阅及不同原生连接隔离。部署前还需在隔离 HOME/数据目录、假 Responses 端点、无真实凭据下运行固定版本真实 CLI，验证 30 秒以上流和执行中 shell 跨 daemon 重启完成，所有页面断开期间完成、queue 只消费一次、goal 续跑及 pending approval 恢复。保留 PID、原 turn ID、请求次数、history/completed 与清理记录。

线上只做不触发推理的健康、身份与菜单检查。真实任务连续性单独获得授权；合成推理不替代真实 OAuth、外部模型、全部工具或桌面呈现验收。

受管 Headless 显式 raw core/downstream overlay 接入见 [受管 Headless](../../operations/managed-headless.md)，不改变其他部署默认模式。


## 网页就绪与 Host 就绪

Headless 的 HTTP/认证启动与独立 Codex Host 的连接初始化分离。后者使用 10 秒单次
初始化期限、1 秒起步至 30 秒上限的指数退避，成功后每 30 秒检测连接是否仍开放；
退出取消当前临时 Client 和重试。结构化日志只记录状态变化及安全诊断，不输出原始
响应或凭据；`/__opencraft_health` 的 `hosts["local-codex"]`独立显示
connecting/ready/unavailable，HTTP 的 ok 不代表该 Host 可执行。

部署的 Core 健康探测只验证经过认证的进程身份，允许观察未来协议版本以保持旧进程；
真实客户端仍严格检查自身支持的 Core 协议，拒绝不兼容连接且不启动内嵌替代进程。
维护 Core 自身的排空与协议升级不是网页发布前置条件。


## 执行侧平滑升级三步方案

原则：**持有任务的进程只在升级自身代码时退出，退出前等待自己的任务自然完成。** 连接、页面或代理进程的生命周期不能决定原生 Turn 的生命周期。DSH/Pi 同样遵循独立任务 owner、单写数据与按会话固定代次的原则；具体引擎协议各自实现。

| 层 | 当前进程与唯一 owner | 数据与升级动作 |
|---|---|---|
| 持有任务 | 独立 APP Server owner 及其 native CLI、原生 shell/PTY | `runtime/` 内原生日志、thread/turn、queue/goal 与执行进程；普通 Core/网关更新保持 PID、固定 payload 和 cgroup。APP Server 自身维护先排空任务、工具、queue、goal、审批与动态能力请求 |
| 持有数据 | 账号 Core | `account-pool.sqlite`、secrets/Host token、亲和性、配额、login/refresh；唯一 writer。账号控制面停止接纳；推理代理继续服务已有 runtime 的后续请求，等全体代理请求空闲后关闭监听、完成维护写入并释放账号锁。维护不接管原生执行 |
| 持有数据 | Headless Host overlay | Host 状态库、队列、sender、附件、Tasks/计划及原有计量；沿原 owner/迁移/结果未知 fence 恢复。当前 Headless 同时包含 HTTP/WS 路由，不能将整个进程称为无状态，也不把 Token collector 归给账号 Core |
| 无状态转发 | Web/relay 与网关传输连接 | 可重连；请求 ID、订阅与连接代次属于连接。业务持久状态仍归原 owner；重连不能授权重发结果未知的 mutation |

### 第 1 步：拆开（已实现，部署显式启用）

`main.cjs` 加 `--app-server-endpoint ABSOLUTE_SOCKET --proxy-port FIXED_PORT` 后只持有账号服务，不 spawn/stop CLI。独立 `app-server.cjs` 通过认证 control `/launch` 获取 synthetic broker 配置，持有 runtime 锁、原生 Unix socket 和认证连接。`/launch` 不返回真实账户凭据，不经过公开网关；同 uid 私有 socket/token 是现有信任边界。

账号地址是固定 `http://127.0.0.1:PORT`；Host token 由现有 secrets owner 持久化，不因 Core 更新重发。计划升级先给账号 Core SIGTERM：先排完 control/account RPC；代理在其他长流排空期间仍接纳现有 runtime 的后续请求，避免并行 shell 完成后被长流维护阻挡。后台登录/配额维护先在代理仍监听时结束；推理自己的凭据刷新仍可完成。只有 active 归零的空闲点才同步关闭代理监听，随后同步关库、释放锁并退出；监听关闭后的启动间隙由原生 CLI 的 Responses 传输重试恢复。Core unit 的停止期限为 infinity，避免 systemd 超时杀掉未排完的流。流永不结束则本次升级等待，不以强杀冒充平滑升级。 关闭等待超过15秒时，结构化诊断区分control、账号RPC、登录、重置券、订阅维护和代理；代理只按固定路由/方法/处理阶段聚合在途数量与最老时长，不记录查询、未知路径、header或body。TCP连接数不等于在途推理或MCP请求，须按这些阶段判断阻塞。

Core 意外崩溃时，已建立的上游流仍会断开；APP Server 不变，依靠原生传输重试，可能增加一次模型请求和延迟。本步骤不重发 `turn/start`，不保证任意长停机、所有外部模型/图片端点都可恢复。恢复期限受固定 CLI 版本的重试预算约束；预算耗尽后的轮次交给第 2 步，不能无限重试结果未知的工具或账户 mutation。图片 turn 的临时关联仍在代理内存，Core crash 后不承诺图片请求恢复；后续如需覆盖必须单独做持久身份设计。

APP Server/native crash 由自身 unit 重启；账号 Core 保持原 PID，健康在新 runtime ready 前返回不可用。旧 Turn 以原生 resume/read 为准，不在本步自动生成新轮次。系统启动先 Core（账号 listener 可用但综合 health 还未 ready），再 APP Server；APP Server 启动在同一 owner 进程内指数退避等待临时不可用的 Core launch 接口（单次 5 秒、退避上限 5 秒，可取消），不通过每秒退出重启消耗 systemd 启动限额；认证/协议/目录身份等永久错误仍明确失败。native 故障由自身 unit 自动重启，不联动账号 Core。禁止两个 unit 之间配置 PartOf、BindsTo、Conflicts 或停止传播。

Core 对网关仍返回 protocolVersion 1 的 `pid/codexPid/nativeSocket`；拆分形态额外提供 appServerPid 和目录身份，pid 仍是账号 Core 的 MainPID。旧部署不传新参数，继续使用原合并形态，不会由新版网关自动拆分。新客户端可连接两种形态；控制端升级不修改原生协议。

### 第 2 步：自动续跑（另项实现）

输入接口是持久执行意图/提交回执及恢复后原生 Thread/Turn 状态，而不是 socket close 或旧健康 PID。恢复 owner 先对账：原 Turn 仍执行/已完成则只恢复订阅；确已终止且允许恢复时才能提交可追溯后继轮次。必须把原 Turn、恢复 episode 与新 Turn 关联，保留未知送达 fence、用户取消、审批和工具副作用；一个 episode 只能有一个提交者。

第 1 步不会在 Core 重启、health 503 或 native 断连时调用 turn/start/resume mutation；只恢复代理传输。第 2 步必须区分账号 Core outage 与 native runtime replacement，以原生权威读数为依据。具体恢复存储/算法由自动续跑实现的正式契约负责，本页不另建队列或第二个 writer。

### 第 3 步：新旧并行（Generation Router，已删除）

此前的第 3 步由 systemd 完整发布装配中的独立 Generation Router（`generations.cjs`、
`codex-generations.sqlite`、按代次路由、退休与冷验证协议及其隔离演练）实现。该装配已无部署使用，
Router 及其 unit、维护协议与测试已于 2026-11-22 删除；Docker、Electron 与 Headless 继续运行单
APP Server／单 `CODEX_HOME`。不中断升级的计划后继是 WorkspaceHost 按工作区固定容器镜像，见
[工作区拆分 §3.5](../platform/workspace-host-split.md#35-generation-router已删除)。
账号 Core 的 `/generation-host` 与 `/generation-directory` 路由、控制客户端方法和 Host 侧的代次
栅栏/路由/故障消费也已删除；Core health 中出现 `routingEpoch` 时，客户端按不兼容拒绝，而不是
静默按单 HOME 继续。

## 拆分的首次上线与回退计划

维护准入由连接 Core 的本地 Codex Host 拥有：在该 Host 的 `dataDirectory` 创建
`codex-admission.paused`，会立即拒绝新的 Thread/fork、Turn、队列输入、goal、独立命令和协作提交；
移除文件恢复。现有 Turn、已接纳队列、goal 的执行与取消、查询及审批回复继续；只改变
status 的 goal 暂停/完成仍允许，夹带 objective/budget 修改仍视为新提交。不靠断连接或
杀进程排空。计划触发器保留 waiting 状态，在恢复准入后重试。该文件不放在
Core 的临时 RuntimeDirectory，Core 重启不会意外恢复准入；正常 payload 安装不覆盖它。

初始化的 `opencraft.codex-maintenance` capability 提供只读
`opencraft/codex/maintenance/read`，返回准入状态、在途提交、排队输入、历史 unknown、
goal、标题任务、待回复请求及容量重试数量；这些数量只属于 Host，不代替原生队列或 goal。
操作者须同时检查这些 Host 状态及原生
loaded/Turn/工具状态，不能把私有 Core health 或页面连接数当成排空证明。
原生独立进程/终端须单独核对，不能由 loaded Thread 为零推断它们已退出。
历史 unknown 仍是结果未知的持久 fence，维护不得删除或自动重发；不能解释其是否仍
有在途执行时不得切换。维护探针和新任务被拒绝的回执要在切换前留存。

本实现与模板不自动在任何现有部署启用拆分。首次迁移是一次显式维护，和随后账号 Core 独立更新不同：

1. 固定已验证、已合入的源码/归档；分别安装 Core 与 APP Server owner bundle 到独立不可变目录，CLI 保持原精确版本。核对现有 unit 的 uid、token、数据根、socket、cwd、端口及 systemd 停止传播；备份 unit/bundle 与各 owner 的最新数据并验证恢复副本。
2. 阻止迁移期间新任务准入，保留会话读/观察；确认原生 Turn、shell、queue、goal、审批/能力请求与账户维护均自然排空。没有 drain authority 或 unknown 未解释则等待，不能只看页面连接数。需要人为暂停持续任务时由操作者单独决定。
3. 在既有部署互斥内停止旧合并 Core，确认全部旧 native/writer 退出。沿用当前数据与 token，启用 accounts 模板（安装名保持原 Core unit）、再启动独立 APP Server unit；不把它放在 execution 的 cgroup 或可移动包链接内。
4. 验证认证 control health、Core MainPID/APP owner/native PID、socket 0600、账号身份、原生会话只读恢复、网关模型能力与无数据移置。网站/Headless 配置的 Core endpoint 不变，网关只需重连。释放部署互斥；部署与运行时实际验证分别记录。
5. 预计在已自然排空后断连约 5–15 秒（本机冷启/重连预算，非主服实测或保证）；排空等待不设时长上限。只有首次旧进程→独立 APP Server 的切换需要替换 native PID；按本原则，活动任务不纳入该中断窗口。若父调度决定跳过排空，须另明确记录受影响 Turn，不能称无中断。

回退先关闭新任务准入并排空原生任务；停独立 APP Server 后停账号 Core，确认两把锁释放，再恢复**兼容当前数据版本**的未拆分 bundle/unit，保留当前账号和 native 数据，恢复原 gateway endpoint。验收原会话与新任务读取/完成；不恢复旧数据库快照、不同时运行两种形态。账号 Core 单独升级失败时只退兼容账号 bundle，APP Server 保持；首次拆分失败才使用整体维护回退。固定旧 reader 若拒绝新 schema，继续前向恢复，不能删除迁移账本。

模板见 `deploy/web-server/opencraft-codex-appserver.service` 和 `opencraft-codex-accounts.service.example`（启用 ENV 投递时另加 `opencraft-codex-appserver-environment.conf.example` drop-in 与 `.json.example` 启动配置，见[网站部署](../../operations/web-deployment.md)）；后者需明确安装为既有 Core unit，而不是额外启动第二账号服务。模板路径/端口必须现场填写，包构建不会安装 unit。

## 拆分隔离演练

```sh
OPENCRAFT_CODEX_EXECUTABLE=/absolute/fixed/codex \
OPENCRAFT_CORE_DRILL_ROOT=/absolute/private/evidence \
npx tsx scripts/smoke/execution/smoke-codex-core-split.ts
```

Linux 上可额外设置 `OPENCRAFT_CORE_DRILL_SYSTEMD=1`，使用自动清理的独立测试 unit/cgroup 执行同一演练，不安装或修改正式 unit。

该脚本只使用合成账号、私有 HOME/数据根和本地 Responses/usage 服务；不从用户 profile 导入凭据。它记录固定 CLI 版本、Core/owner/native PID、原 Thread/Turn、Core 延迟 12 秒启动时的同进程等待、35 秒流与并发 8 秒 shell 在排空期间的后续请求、36 秒 shell 的 start/done 次数、Core crash 后模型重试次数、APP Server crash 后只读恢复，以及保留当前数据退回合并形态。报告留在私有证据目录，进程与 listener 在结束时停止；合成模型不证明真实 OAuth/外部模型可用。

### 无 systemd 的拆分形态（桌面）

账号 Core 加单个独立 APP Server（`app-server-bin`）本身不依赖 systemd：APP Server 直接启动 native，不需要 systemd 监督。不设 `OPENCRAFT_CORE_DRILL_SYSTEMD` 时，上述演练在 Linux 上用固定的 native 0.162.1 全部通过，包括 Core 重启与崩溃、APP Server 崩溃后由新 owner 接手，以及退回合并形态；Codex bridge 也能经该 Core 的 `/launch` 与 native socket 完成握手。合并形态不提供 `/launch`，bridge 只能接拆分形态。

演练和部署必须直接使用 native 可执行文件，不能用 npm 的 `codex` 启动脚本：没有 cgroup 时，强杀启动脚本会留下仍占用同一 `CODEX_HOME` 的 native 子进程，新的 owner 会因此拒绝启动。账号 Core 的开机身份在 Linux 仍取内核 boot ID，macOS 取 `kern.bootsessionuuid`，Windows 取最近启动时间。Windows 目前仍不可用：Core 与 APP Server 只监听 Unix socket。

## 准入拒绝记录

Host 的维护只读快照新增可选 `rejectedAdmissions`，统计当前 Host 实例拒绝的 RPC 尝试数，
重试分别计数。每次拒绝同时经现有诊断端口输出 `codex-admission-rejected`，包含时间、
进程 ID、实例内累计数、方法、逻辑 client ID、目标 Thread UUID 与拒绝原因；不输出
input、objective、工具参数或请求正文。新建 Thread 尚无 ID 或 ID 格式无效时记为 null，
不能把 client ID 当作 Thread ID，也不能据此推断用户身份或目标所有权。

原始 bridge 与 Host overlays 复用同一个 Host 计数与诊断 owner；维护和 generation fence
分别标记原因。读请求、已经接纳的工作及允许的 goal 暂停/完成不计入拒绝。
诊断输出失败不改变拒绝及其 RPC 错误，另输出固定失败标记，不输出异常正文。
服务部署需将诊断输出接入持久日志；跨 Host 重启的窗口总数按时间范围内的事件条数汇总，
不能把重置后的实例计数当成整个窗口累计值。持久日志不可用时明确报告审计不完整。

## Split account Core owner handoff

Linux split accounts expose authenticated local `/owner-handoff` with protocol 1.
The private `scripts/full-upgrade/account-core-owner.mjs` adapter uses the same
fence/inspect/release/cold-ready/resume lifecycle as other upgrade owners. Its
fixed private descriptor contains the Unix endpoint, expected PID and control
token. It is not a complete parent upgrade recipe.

The account Core advertises `operatorLeaseProtocolVersion: 1`. New fences
require `operatorLease: { version: 1, id, controller: { pid, startTime, bootId },
ttlMs }`, with a live same-boot Linux process and a 1–30 second TTL. The public
adapters bind their own PID, renew every three seconds (default TTL 15 seconds),
start renewal before awaiting potentially slow fence quiescence, and stop it after
abort or release. A claim recorded as automatically terminated cannot fence again.
`renew-operator-lease` carries the exact
owner/epoch/operation/fence and original claim. It advances only this incarnation's
monotonic deadline; it never replaces a drain proof or changes sealed data.
Renewal remains available while an asynchronous maintenance interruption settles.
Missing, dead, reused-PID, foreign-boot and expired bindings fail closed.

While the original source can still abort, operator death or expiry automatically
persists `phase: open` and an `operatorLeaseAborts` receipt containing the exact
owner/epoch/operation/fence, claim, reason (`operator-exited` or `lease-expired`)
and timestamp. Unknown outcomes, pending responsibilities, history and retained
state are preserved. Source polling is 100 ms, subject to the process event loop
and durable storage completing; persistence failure keeps admission unhealthy.
The snapshot's `operatorLeaseStatus` is an ephemeral observation, not cold proof.
An abort receipt proves only intrinsic admission was reopened. External network
gates and consumer stop intents still require their controller's exact recovery.
No lease timeout opens a released/cold-ready owner, an irreversibly closing writer,
or an old fenced process after restart; those retain explicit cold recovery.

The account authority owns OAuth and maintenance subprocesses, account mutations,
HTTP request bodies, the upstream concurrency queue, credential refresh, complete
response streams and affinity writes. Fence closes new proxy requests before body
reading, and closes new account operations before dispatch. Previously admitted
operations finish naturally. Source-side OAuth poll/cancel remains available;
pending logins block release. Periodic maintenance stops admitting work while
fenced. A disconnected caller does not cancel an accepted account write. A lost
proxy delivery receipt latches durable uncertainty, including after process
replacement, and cannot produce an idle proof.

The account writer never opens native history or changes generation routing.
APP/native, route pins, loaded questions/approvals, goals, schedules, queues,
rollouts and attachments retain their original owners and processes. Proxy wire
protocol, Host tokens and account RPCs are unchanged, so old and new APP owners
can use either provider. A proxy 503 includes Retry-After; native retries have a
finite budget. A surviving native process is not a promise that its Turn will
survive a long maintenance window. A stream already admitted is fully drained;
new model requests can fail when that budget expires.

The source binds the operation, epoch, fence, boot ID and incarnation to a fresh
15-second proof. Release rechecks zero occupancy, seals image-turn associations,
completed OAuth receipts and exact reset-credit attempt keys/outcomes, then closes
the account services and records the current storage digest. Completed unknown
reset outcomes stay unknown; handoff does not redeem or replay them. Uncertain
in-flight work blocks release. `abort` reopens only the same source before writer
release begins, preserving accepted work. The source process must then stop;
its kernel accounts lock prevents a successor from opening the same data root.

Before startup recovery or expiry pruning, a frozen successor reads every table
and schema/migration row in `account-pool.sqlite`, runs integrity/foreign-key
checks, verifies SQLite sidecar permissions, and reads every file under secrets,
login and refresh. Credential references are checked at their external paths.
Owner files/directories must belong to the service UID and exclude group/other
permissions; links and unknown credential records are rejected. Cold readiness
also validates credentials, the original storage digest, fixed CLI hash, proxy
port, endpoints, token selector, fixed launcher path, stable service environment
(excluding process-specific systemd fields), data/HOME/cwd configuration and retained receipt
digest. It binds the actual bundle hash, Node version/modules ABI, platform and
architecture to the successor incarnation. Resume recomputes it; a prior
process's readiness cannot authorize a replacement. Frozen construction does not
run login recovery or remove maintenance files. The durable resume decision
precedes those normal startup effects, and admission waits for their completion.
Retained records are independent of readiness and survive open-state restarts.
Protocol 1 shares a 64 MiB durable limit and a 128 MiB response limit; complete
serialization with successor headroom is checked before the old writer closes.
A list that cannot fit leaves the source available for abort without truncation.

The supported safe starting point is protocol-1 split accounts with unchanged
account migrations 1–3, fixed CLI and configuration. A legacy provider or combined
Core needs an explicit maintenance bridge. Combined shutdown also stops native
execution; it cannot claim split continuity. Such a bridge records any normal
question/approval cancellation and actual interruption, without editing logs,
arming goals or replaying mutations.

For a split protocol-1 account source that cannot carry a nonempty unknown list,
the fixed successor CLI has two explicit offline modes:
`--inspect-account-maintenance` reads the current storage/configuration/CLI
digests without starting services; `--seal-legacy-account-maintenance <receipt>`
acquires the accounts writer lock and seals a private maintenance receipt.
The receipt binds the stopped source PID/start time, boot, bundle digest,
fenced owner/epoch/operation, exact unknown list and zero occupancy snapshot.
Every historical responsibility must be accounted for by persistent affinity
rows: additional image affinities or completed login/reset receipts make this
legacy starting point unsupported. Check this before stopping the source and
abort its fence when unsupported. The seal rechecks it against current storage;
it does not fabricate a cooperative source release. Cold readiness identifies
this as `releaseKind: legacy-maintenance` and binds the receipt digest. No
database restore, mutation replay or unknown removal is part of this bridge.

The deployment owner must hold its lock continuously across source fencing,
stop, offline seal, cold readiness and any compensation. Drain naturally, wait
the agreed grace period and resnapshot the exact list before fencing. Source
control shutdown closes connections with incomplete headers or already answered
reads; accepted handlers still finish and flush their responses. A legacy
control parser stall cannot justify killing work: explicit process termination
requires a verified zero-work snapshot, durable fence and no unexported volatile
responsibility. A failed switch restores a compatible bundle against current
data under the same lock, or leaves the durable fence for reconciliation.

After confirmed release, a failed candidate is stopped before restarting a
compatible previous bundle against current data. The recovered process takes a
new cold proof before admission opens. It never restores an old database snapshot.
An unconfirmed release stays fenced for explicit reconciliation. The deployment
owner retains its existing activation lock throughout switching and compensation.
Account evidence is not a backup or cold-read proof for native/Host stores.

The isolated split drill supports `OPENCRAFT_CORE_HANDOFF_DRILL=1` for real CLI
long streams, shell continuity, candidate failure, stale-proof rejection and
native retry exhaustion. `OPENCRAFT_CORE_COMPAT_ONLY=1` runs a short wire test;
`OPENCRAFT_DRILL_LEGACY_OWNER` plus `OPENCRAFT_DRILL_LEGACY_CORE=1` or
`OPENCRAFT_DRILL_LEGACY_RUNTIME=1` selects a separately built fixed baseline child.
Only synthetic credentials and a loopback model are used. Reports retain exact
Node/CLI/build evidence and measured interruption, not external OAuth/model claims.


Core-owned stores and reference files require the service UID. A root service may cold-read an
explicitly configured private regular external auth file owned by its independent credential writer.
The proof binds the external file's actual UID, mode and content digest; any change invalidates
readiness. Core never takes ownership of or writes this external file.

### Delegated tool memory guard (implementation, not activated)

The opt-in Linux prototype in `scripts/server-deployment/tool-memory-guard.py`
observes process fork/exec events outside native and adopts tools into child
cgroups under an already delegated generation service. It does not modify native,
create delegation on a running legacy owner, read command/session content, or
reject commands based on a sum of tool limits. Helpers are adopted as tools too.
Proc-connector thread events are filtered; loss/unavailability is reported before
100ms polling fallback. Startup reconciliation recovers orphaned tools.

New owners require `Delegate=yes`, `DelegateSubgroup=app`, finite owner limits and
`OOMPolicy=continue`. The APP unit has `OOMScoreAdjust=-1000`; the guard sets native
to -999 and adopted tools/descendants to 0. Native must remain killable if the guard
fails. The guard is supervised independently with `Restart=always`; the per-tool
cgroup has `memory.oom.group=1`. Adoption is best effort: earlier allocations remain
charged to the owner leaf; its total limit covers both leaf and tool subtrees.
Normal-load latency and sampled anonymous residue are measured, not universal
allocation bounds. The package carries the guard, an operator-editable policy sample and an offline
configuration renderer. Host activation remains opt-in and requires a new owner.

The local-only real-CLI smokes are `smoke-tool-memory-native.py` (50 simultaneous
built-in shell tools with a full-speed allocator) and `smoke-tool-memory-guard.ts`
(real APP/native priority and guard-down OOM recovery). They use private synthetic
accounts and loopback fixtures and must never run on the main server. Nested
retirement/inventory tests continue to verify the entire owner subtree.

Occupancy/inventory and delegated retirement compare two complete directory and
membership snapshots. A changed snapshot cannot certify stable/idle work during
adoption. Guard recovery removes empty groups before parsing their limits, since
a crash between mkdir and controller setup can leave `memory.max=max`.


The sample `config/tool-memory-guard.json` sets each tool (including helpers) to
12GiB High / 16GiB Max. These are policy values, never reservations or a budget
admission test. `toolPidsMax=max` adds no new task-count restriction; the owner's
existing TasksMax still applies. A small owner's total may be below one tool's
maximum. Operators must size a generation for its intended traffic.

`opencraft-tool-memory-prepare` stages a versioned Python payload, policy,
standalone `Restart=always` service and a precise `99-delegated-tool-memory.conf`.
It never mutates host configuration. The deployment owner holds its normal lock,
backs up existing files, verifies the target generation is not running and
applies only to that new owner. The guard payload is an independent versioned
regular file so release garbage collection cannot delete it. A running operator
policy is preserved; policy updates require a controlled guard restart.

The supervisor discovers native exec through proc connector and reconciles
systemd units on startup/restart/loss; only finite, explicitly delegated `app`
owners with continue/-1000 qualify. Workers adopt tools via fork/exec events.
Missing connector support is reported before 100ms polling fallback. Legacy
undelegated owners are skipped. Worker/guard failure never blocks tool exec.
APP makes its native child -999 before publishing readiness if APP is -1000,
so even an unavailable guard cannot leave the whole generation OOM-immune.

High and OOM observations contain generation, kernel comm process names, peak
bytes, UTC time, counter increments and cumulative counters. No argv, environment
or session/tool content is read. High increments are aggregated per observation
rather than producing an unbounded log storm; every kernel count remains in the
delta. Group OOM occurrences and killed-process counts are distinct. Counters
are read once more before group deletion; restart re-observation carries stable
counter-based keys for deduplication. These are observed peaks; absent historical
process names cannot be reconstructed after a crash.

A CLI launcher can fork native before its own score is changed. Protected APP
startup therefore raises inherited -1000 across its owned native family
parent-first, repeats after native readiness, and leaves score 0 unchanged.
Launcher exit is failure immediately even if a grandchild still holds stdio;
waiting only for ChildProcess close would defer recovery. The local forced-launcher
smoke (`OPENCRAFT_TOOL_MEMORY_FORCE_WRAPPER_IMMUNITY=1`) verifies this before guard
startup and bounds recovery with inherited open pipes. It also accepts a canonical
APP bundle and packaged guard payload for artifact-level tests.


### Hash-aware fenced source compatibility (local qualification)

`--seal-fenced-account-maintenance <receipt>` is an explicit offline compatibility
entry, separate from the older pre-hash legacy importer. It accepts only a
`fenced-account-maintenance` receipt: the original source snapshot and proof remain
unmodified, including the complete unknown list, its hash/count, and the SHA-256
of the durable fenced account state (`sourceStateSha256`). A live source or a
changed state, storage, configuration, CLI, or history is rejected.

A controller must hold its real kernel locks and complete outer admission barrier,
obtain a fresh authenticated fenced source proof, and publish a durable, identity-
bound maintenance stop permit before stopping the source. This command does not
provide that controller, stop a source, or establish a migration time budget.
It opens no account writer admission. Existing ordinary/legacy paths do not infer
this mode from a failed fence or silently accept a new receipt kind.

This entry supports **empty volatile responsibility only**: every source account
count must be zero, retained arrays empty, and the proof historical count must
exactly equal the current persistent `pool_affinity` row count. Zero active calls
alone is insufficient. Image affinities and login/reset receipts may remain after
calls finish; their presence must cause same-lock abort/recovery before a source
stop permit, never fabricated empty arrays or deletion. The successor imports all
unknowns unchanged from current data; no request, login, or tool is replayed.

The purpose is compatibility with a fenced, hash-aware source whose control
request limit cannot carry its full historical list. It does not make the
original source's ordinary release accept a partial list or a digest reference.
A separately qualified guardian, controlled recovery, actual Native continuation,
and large-scale forward/recovery budget evidence are required before operational
use; this local protocol implementation alone grants no lifecycle permission.


### Complete retained exports for a request-limited source

`--inspect-account-retained-export <file>` validates a private full export and
returns only its digest, source identity and row counts without acquiring a writer
or starting services. `--inspect-exported-account-maintenance <receipt>` additionally validates the
complete projected successor state while the source is still alive: current
storage/configuration/CLI, full retained state and both historical arrays must
fit the 64 MiB state bound with 4096 bytes reserved for successor metadata. It
does not acquire a writer or modify the source; capacity rejection remains
abortable before any stop permit is used.

`--seal-exported-account-maintenance <receipt>` consumes an
explicit `exported-account-maintenance` receipt after the separately controlled
source exit. The receipt binds the original fenced state byte hash, unchanged
source snapshot, full historical unknown hash/count, and the complete identity-
bound retained export. Image affinities, original login outcomes and reset-credit
outcomes (including unknown) are restored exactly; missing arrays, duplicate IDs,
invalid outcomes, changed source identities, digests or aggregate history fail
before any sealed state is written. A partial export never becomes empty.

The deployment owner must qualify its observer separately: collect from the
original live owner while outer admission is closed and verify that persistent
`pool_affinity` rows plus all three actual retained arrays equal the original
historical count. The observer's `v8-side-effect-checked` provenance is supplied
by that privileged controller, not inferred or authenticated from a client claim.
The offline importer remains a private operator interface, never an end-user
route. It neither attaches a debugger nor stops or interrupts any process.

New Core owner-handoff JSON requests use the existing 64 MiB account-state bound,
so a complete historical list can cross the next ordinary fence. Other private
control JSON (including account mutations) retains its 1 MiB default. Original
request-limited source bytes remain unchanged and require the explicit bridge;
raising a successor limit cannot make an old source accept a large request.

The exported sealer acquires the account writer before its strict import
validation, and returns a detached copy of the inspection actually bound into
that release seal. It avoids duplicate pre/post storage and fixed-CLI hashing;
source-exit, full retained/schema, storage/configuration/CLI checks still run
before writing, and load verifies current sealed storage again. Repeating the
command on an already sealed operation performs a fresh inspection. Existing
legacy and empty-retained entry points retain their original reads.

## Account maintenance diagnostics

Account health and an individual Settings operation are different resources. The
account owner may project optional `maintenance` observations on account/list:
`checking` is an active check, `unverified` is a locally renewed credential awaiting
provider confirmation, `error` is a classified failed check, and `ok` requires a
provider-accepted observation. `checkedAt` and `lastSuccessAt` are owner timestamps.
These bounded, per-account observations are in memory, reset with that owner, and
are neither a credential database nor handoff/execution authority. Older Hosts
omit them; absence never proves a failed operation succeeded.

Failures contain an allowlisted code, stage (`renewal`, `usage`, `operation`), time,
retryability and generated diagnostic ID, optionally an HTTP status and a safe
transport-reason enum. Background maintenance, Account Core control replies and
Host RPC errors carry the same projection. Logs emit `account-operation-failed`
and transition-only `account-check-recovered` with a hashed local account reference.
They never contain raw exceptions/stacks, provider response bodies, emails, tokens,
request parameters, URLs or credential paths. Core rejection distinguishes invalid
input, maintenance admission, timeout, terminal authorization and temporary service
failure. An accepted operation is not relabelled fenced just because admission
closed while it ran. Structured retryability is guidance for an explicit user
retry; it does not authorize automatic replay of a mutation or an unknown outcome.

Managed renewal rejects a still-expired result or an unchanged credential after
an authorization rejection. A delayed renewal cannot overwrite a newer credential.
Writing a renewed file preserves existing authorization failure; successful usage
or an accepted inference authorization confirms recovery. An empty managed usage
payload retains the prior authorization/quota contract rather than erasing a
failure. Transient renewal failure does not mark the account terminally unauthorized.
External references remain read-only; there is no cross-store token copying or
implicit change of credential-renewal owner.

Settings presents transient checks separately from authentication rejection,
provides localized recovery guidance, check times and a copyable diagnostic ID.
A newer successful check can retire a failed refresh notice; it cannot erase a
failed enable/remove/reorder or other mutation. Such feedback explicitly describes
the previous operation, can be dismissed, and never displays an arbitrary upstream
exception. The existing Settings components, input-density targets and responsive
account row remain in use.
