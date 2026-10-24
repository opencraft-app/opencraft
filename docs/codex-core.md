# 服务器 Codex 核心服务

服务器可显式启用 `@opencraft/codex-core`。默认兼容形态将 `codex app-server`、账户池代理、登录、凭据刷新与用量维护放在同一个独立长驻进程中；显式拆分形态把 APP Server 移至另一个独立 unit，账号 Core 可以单独升级。执行网关和 daemon 只持客户端连接。关闭最后一个页面、关闭 daemon 或重启执行侧不终止所选常驻执行 owner 中的活动轮次、shell 工具、原生 queue 与 goal。

桌面端默认继续使用 daemon 内嵌 stdio 模式。没有 `--codex-core-endpoint` 时不会探测或启动核心服务。服务器执行更新可接入[受管更新器](web-deployment.md#服务器执行端更新)，只切换网关、daemon 和 capability adapter，保持 core 与 CLI 运行。网页/网关发布不等待 Core 更新、目标完成或账户源码同步；两者分别报告实际版本。多代会话分配与 DSH 宿主自身平滑升级仍属后续设计。

## 所有权与协议

- 账号 Core 是 Codex 数据目录内 `account-pool.sqlite`、`secrets/`、`login/`、`refresh/` 的业务 owner；`runtime/` 的唯一运行时 owner 是所选形态中的 APP Server。daemon 远程模式不打开这些目录。
- CLI 的 `CODEX_HOME` 是 `<data-directory>/runtime`，工作 cwd 来自显式 `--runtime-directory`。CLI 只收到回环代理 URL 和 synthetic Host token；真实账户凭据由代理读取。兼容模式的代理端口在 Core 生命周期内稳定；拆分模式显式固定 loopback 代理端口，持久 Host token 跨 Core 重启稳定。
- 原生入口为 `codex app-server --listen unix://...`。Unix socket 使用 WebSocket HTTP Upgrade，连接各自 initialize，不能当 JSONL 使用。每个 daemon adapter 持一个原生连接，负责 logical client 与请求 ID 映射。同一连接上的逻辑订阅计数，最后订阅者离开才发送 native unsubscribe。
- `GET /health` 与 `POST /accounts` 位于独立 Unix HTTP 控制 socket；后者接受 `{method, params}`，仅转发 `opencraft/codex/accounts/*`。两者要求 `Authorization: Bearer <daemon token>`，与 daemon 共用私有 token 文件。无远程 shutdown 接口。
- socket 目录必须为 0700，控制与原生 socket 均为 0600；原生 listener 依靠 Unix 文件权限限制访问。CLI 可能把原生路径建为符号链接，验收应使用 `stat -L` 检查实际 socket，不能把符号链接自身的 0777 当作目标权限。不要将原生 socket 通过公开网关暴露。
- 健康检查返回协议版本、core PID、所选 Codex 子进程 PID 与原生 socket。官方 npm CLI 可能有 Node wrapper，部署验收还须记录其实际 native 子进程 PID，不能只比较 wrapper。
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

## 切换、升级与回退

首次切换在隔离验收通过后进行：确认部署工作区空闲、旧 Codex 无加载/活动会话；备份执行网关、daemon bundle、unit 与私有 Codex 数据。停止旧 writer 后，核心服务才能打开原目录。切换执行网关参数并启动独立 unit，核对两条 `runtime/machine/read`、模型菜单两组及健康状态。再次重启执行侧，比较 core、wrapper 和 native PID，并在页面重连后检查 Codex 可用。

**未拆分形态下，升级 CLI、核心服务或账户代理代码需要重启 core，会中断正在运行的 Codex 任务。拆分形态只有 APP Server/CLI 自身维护需要排空原生任务；账号 Core 更新按下方独立流程排空代理请求。** 本方案把它们移出普通执行侧升级范围。当前原生协议没有完整 drain 事务；维护前检查活动轮次、工具、queue、goal、待审批与账户维护。不得为维护隐式暂停 goal 或批准请求。持续活动无法自然清空时需由操作者明确安排暂停/取消。不宣称跨 CLI 版本兼容或 APP Server crash 后原地续跑。Core crash 的原生流重试与 APP Server crash 的轮次恢复是不同边界。

回退内嵌模式同样需要维护窗口：先停止执行侧、停止并禁用 core，确认 native writer 退出，再恢复备份的网关参数和 daemon bundle，移除执行侧 core 依赖并启动执行侧。通常保留当前数据，不自动用旧备份覆盖新会话或账户变更。具体备份和回退脚本属于部署记录，不提交机器路径或凭据。

## 验证

```sh
npm run typecheck --workspace @opencraft/codex-core --workspace @opencraft/opencraft-daemon --workspace @opencraft/account-pool-host --workspace @opencraft/workbench-electron
npm run test:appserver
npm run test:codex-core
npm run check:boundaries
```

核心测试覆盖账户控制鉴权与转发、零连接生命周期、重复 writer 拒绝、远程不可用不回退、同连接多逻辑订阅及不同原生连接隔离。部署前还需在隔离 HOME/数据目录、假 Responses 端点、无真实凭据下运行固定版本真实 CLI，验证 30 秒以上流和执行中 shell 跨 daemon 重启完成，所有页面断开期间完成、queue 只消费一次、goal 续跑及 pending approval 恢复。保留 PID、原 turn ID、请求次数、history/completed 与清理记录。

线上只做不触发推理的健康、身份与菜单检查。真实任务连续性单独获得授权；合成推理不替代真实 OAuth、外部模型、全部工具或桌面呈现验收。

受管 Headless 显式 raw core/downstream overlay 接入见 [受管 Headless](managed-headless.md)，不改变其他部署默认模式。


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

账号地址是固定 `http://127.0.0.1:PORT`；Host token 由现有 secrets owner 持久化，不因 Core 更新重发。计划升级先给账号 Core SIGTERM：先排完 control/account RPC；代理在其他长流排空期间仍接纳现有 runtime 的后续请求，避免并行 shell 完成后被长流维护阻挡。后台登录/配额维护先在代理仍监听时结束；推理自己的凭据刷新仍可完成。只有 active 归零的空闲点才同步关闭代理监听，随后同步关库、释放锁并退出；监听关闭后的启动间隙由原生 CLI 的 Responses 传输重试恢复。Core unit 的停止期限为 infinity，避免 systemd 超时杀掉未排完的流。流永不结束则本次升级等待，不以强杀冒充平滑升级。

Core 意外崩溃时，已建立的上游流仍会断开；APP Server 不变，依靠原生传输重试，可能增加一次模型请求和延迟。本步骤不重发 `turn/start`，不保证任意长停机、所有外部模型/图片端点都可恢复。恢复期限受固定 CLI 版本的重试预算约束；预算耗尽后的轮次交给第 2 步，不能无限重试结果未知的工具或账户 mutation。图片 turn 的临时关联仍在代理内存，Core crash 后不承诺图片请求恢复；后续如需覆盖必须单独做持久身份设计。

APP Server/native crash 由自身 unit 重启；账号 Core 保持原 PID，健康在新 runtime ready 前返回不可用。旧 Turn 以原生 resume/read 为准，不在本步自动生成新轮次。系统启动先 Core（账号 listener 可用但综合 health 还未 ready），再 APP Server；APP Server 启动在同一 owner 进程内指数退避等待临时不可用的 Core launch 接口（单次 5 秒、退避上限 5 秒，可取消），不通过每秒退出重启消耗 systemd 启动限额；认证/协议/目录身份等永久错误仍明确失败。native 故障由自身 unit 自动重启，不联动账号 Core。禁止两个 unit 之间配置 PartOf、BindsTo、Conflicts 或停止传播。

Core 对网关仍返回 protocolVersion 1 的 `pid/codexPid/nativeSocket`；拆分形态额外提供 appServerPid 和目录身份，pid 仍是账号 Core 的 MainPID。旧部署不传新参数，继续使用原合并形态，不会由新版网关自动拆分。新客户端可连接两种形态；控制端升级不修改原生协议。

### 第 2 步：自动续跑（另项实现）

输入接口是持久执行意图/提交回执及恢复后原生 Thread/Turn 状态，而不是 socket close 或旧健康 PID。恢复 owner 先对账：原 Turn 仍执行/已完成则只恢复订阅；确已终止且允许恢复时才能提交可追溯后继轮次。必须把原 Turn、恢复 episode 与新 Turn 关联，保留未知送达 fence、用户取消、审批和工具副作用；一个 episode 只能有一个提交者。

第 1 步不会在 Core 重启、health 503 或 native 断连时调用 turn/start/resume mutation；只恢复代理传输。第 2 步必须区分账号 Core outage 与 native runtime replacement，以原生权威读数为依据。第 3 步提供 generation ID/接纳 epoch 后，恢复意图也按该代次查询；旧代任务未完成不能仅因新代 ready 就启动重复执行。具体恢复存储/算法由自动续跑实现的正式契约负责，本页不另建队列或第二个 writer。

### 第 3 步：新旧并行（方案，未实施）

固定路由协调 owner 单写 `threadId → generationId` 及接纳 epoch；独立 APP Server generation 只拥有自己的 native `CODEX_HOME`、socket 和固定 CLI/payload。所有 generation 共用**同一个**账号 Core loopback 代理，通过现有 Host token 与 thread affinity 选账号，不让它们打开 account-pool 或 secrets；配额、刷新和账户亲和性保持单写。

候选 ready 后原子切换新建 Thread 默认 generation。既有会话的读取、resume、输入、工具回复、queue/goal 和取消继续去其原 generation，目录查询聚合去重；客户端重连不改变归属。迟到响应同时校验 Thread、generation、Turn 与连接 epoch。旧 generation 停接新建 Thread，现有任务自然排完再退，不能以超时杀进程完成退休。已加载但空闲的 Thread 不要求旧二进制永久驻留：退役事务先关闭该 runtime 的新执行准入（未接纳请求明确可重试，未知送达先对账），最后核实无 Turn/工具/queue/goal/审批后关闭 native，保留原 HOME 的绝对路径。以后该 HOME 中的 Thread 再被访问时，由当前版本对同一 HOME 独占冷启动，兼容性/备份验证通过并更新 registry 的 runtime incarnation 后再接纳输入；新建 Thread 仍进新的 HOME。这样无需把运行中的原生 SQLite/rollout 挪到别处，也能退出旧版本。对不同 HOME 合库或逐 Thread 搬迁仍需另验原生导入/导出，首版不依赖此能力。当前同版本隔离回退已经验证“旧 native 退出→同 HOME 新 owner→原 Thread/Turn 历史恢复”，不替代未来跨 CLI 版本的兼容演练。

**不能让新旧 APP Server 共用同一个可写 CODEX_HOME。** 固定 0.162.0 隔离实验中，第二进程能启动同一 HOME，但 resume 第一个进程已加载的 Thread 被原生拒绝为 `already has an active writer`。SQLite 可打开并不表示会话可跨进程任意接管，跨版本日志、auth/config 和 loaded-thread 状态也不是可共享无状态资源。第 1 步的两个 owner 锁明确区分账号与运行时；第 3 步将 runtime 锁按代次目录实例化，保留账号锁。当前第 1 步故意只允许一个 runtime，尚无 generation registry；并行阶段需新增 registry、按 Thread 分派、代次目录和退休回执，不需再把账号服务搬回 APP Server，也不依赖全局随机端口/进程内对象。

共享 Host overlay 库仍只有一个 owner，generation 只提供原生帧。账号 Core、Host overlay 和未来 registry 的写权限不得复制到每代。旧代包/CLI/目录被活动映射引用时不能被版本清理删去。新代失败只撤回新建路由，已有新代写入保留；数据兼容不足时前向修复或保留该代，不恢复旧快照。长期 goal/queue/schedule、待审批或 unknown 保持旧代与明确诊断；不自动暂停、取消或批准来制造空闲。

## 拆分的首次上线与回退计划

本实现与模板不自动在任何现有部署启用拆分。首次迁移是一次显式维护，和随后账号 Core 独立更新不同：

1. 固定已验证、已合入的源码/归档；分别安装 Core 与 APP Server owner bundle 到独立不可变目录，CLI 保持原精确版本。核对现有 unit 的 uid、token、数据根、socket、cwd、端口及 systemd 停止传播；备份 unit/bundle 与各 owner 的最新数据并验证恢复副本。
2. 阻止迁移期间新任务准入，保留会话读/观察；确认原生 Turn、shell、queue、goal、审批/能力请求与账户维护均自然排空。没有 drain authority 或 unknown 未解释则等待，不能只看页面连接数。需要人为暂停持续任务时由操作者单独决定。
3. 在既有部署互斥内停止旧合并 Core，确认全部旧 native/writer 退出。沿用当前数据与 token，启用 accounts 模板（安装名保持原 Core unit）、再启动独立 APP Server unit；不把它放在 execution 的 cgroup 或可移动包链接内。
4. 验证认证 control health、Core MainPID/APP owner/native PID、socket 0600、账号身份、原生会话只读恢复、网关模型能力与无数据移置。网站/Headless 配置的 Core endpoint 不变，网关只需重连。释放部署互斥；部署与运行时实际验证分别记录。
5. 预计在已自然排空后断连约 5–15 秒（本机冷启/重连预算，非主服实测或保证）；排空等待不设时长上限。只有首次旧进程→独立 APP Server 的切换需要替换 native PID；按本原则，活动任务不纳入该中断窗口。若父调度决定跳过排空，须另明确记录受影响 Turn，不能称无中断。

回退先关闭新任务准入并排空原生任务；停独立 APP Server 后停账号 Core，确认两把锁释放，再恢复**兼容当前数据版本**的未拆分 bundle/unit，保留当前账号和 native 数据，恢复原 gateway endpoint。验收原会话与新任务读取/完成；不恢复旧数据库快照、不同时运行两种形态。账号 Core 单独升级失败时只退兼容账号 bundle，APP Server 保持；首次拆分失败才使用整体维护回退。固定旧 reader 若拒绝新 schema，继续前向恢复，不能删除迁移账本。

模板见 `packaging/web-server/opencraft-codex-appserver.service` 和 `opencraft-codex-accounts.service.example`；后者需明确安装为既有 Core unit，而不是额外启动第二账号服务。模板路径/端口必须现场填写，包构建不会安装 unit。

## 拆分隔离演练

```sh
OPENCRAFT_CODEX_EXECUTABLE=/absolute/fixed/codex \
OPENCRAFT_CORE_DRILL_ROOT=/absolute/private/evidence \
npx tsx scripts/smoke/execution/smoke-codex-core-split.ts
```

Linux 上可额外设置 `OPENCRAFT_CORE_DRILL_SYSTEMD=1`，使用自动清理的独立测试 unit/cgroup 执行同一演练，不安装或修改正式 unit。

该脚本只使用合成账号、私有 HOME/数据根和本地 Responses/usage 服务；不从用户 profile 导入凭据。它记录固定 CLI 版本、Core/owner/native PID、原 Thread/Turn、Core 延迟 12 秒启动时的同进程等待、35 秒流与并发 8 秒 shell 在排空期间的后续请求、36 秒 shell 的 start/done 次数、Core crash 后模型重试次数、APP Server crash 后只读恢复，以及保留当前数据退回合并形态。报告留在私有证据目录，进程与 listener 在结束时停止；合成模型不证明真实 OAuth/外部模型可用。
