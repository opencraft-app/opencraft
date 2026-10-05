# 桌面资源准备契约

状态：CTL 源码与模拟 TAT/API/Gateway 测试；未部署、未运行真实云命令。此接口只准备现有桌面环境，不提供 WebRTC、观看租约或输入控制授权。

## 所有权与接口

CTL 从权威 Instance 记录核验请求用户和当前 Sandbox。缓存按实例查找，但记录必须同时匹配用户、Sandbox 和当前绑定代次；换用户或换机器不可复用旧状态、VNC 密码或安装进度。

| 接口 | 意图 | 副作用 |
|---|---|---|
| `POST /v1/instances/{instance_id}/desktop/resource` | 明确准备或重试 | 创建有界后台任务；重复请求共享在途任务 |
| `GET /v1/instances/{instance_id}/desktop/resource` | 观察准备状态 | 只读取；不创建缓存、不下发 TAT、不启动桌面、不刷新空闲时间 |
| 旧 `POST/GET …/desktop/session` | 兼容现有 noVNC 客户端 | 保留启动、轮询和续期行为；不作为新观看契约 |

POST 在准备中返回 202，已准备或其他已知状态返回 200。GET 返回 200。无身份拒绝；不属于当前用户的实例按不存在处理。HTTP 身份头必须由受信 Gateway 注入，不允许直接公开 CTL 后信任客户端自报用户。

资源响应只有 `resource_id`、`generation_id`、`state` 和可选 `progress`。状态为 `unprepared/preparing/prepared/paused/failed`；不返回 VNC 密码、地址、Sandbox 标识、内部失败原因或安装消息。协议枚举不应直接显示到 UI。

`generation_id` 是当前 CTL 进程内的绑定/编排代次，不是访问凭据，也不是物理媒体进程的 incarnation。`prepared` 表示既有桌面 HTTP 探测与独立观察服务启动命令均成功；不是视频、数据通道、物理身份或输入授权就绪证明，亦不是持续健康承诺。观察服务启动中仍为 `preparing`；失败或归属变化不得发布准备成功。

## 后台推进

- 后台准备有 15 分钟总预算，仅保留已核验用户、地域与数据库上下文，不持 HTTP Cookie/Bearer。请求断开不会取消工作。
- TAT 拉起后按需要安装图形层、观察安装完成、继续拉起/探测，不依赖浏览器 GET 推进状态。单次安装仍保留原 10 分钟预算。
- 安装结束清除缺少图形层时留下的启动时间窗，下一步必须真正启动服务，而非继续只探测；测试同时核验具体启动命令。
- 同一绑定的并发 POST 合并。换机与失败/暂停后的显式重试替换可变记录，而不只修改 generation 字符串；旧回调只能修改已脱离缓存的旧对象。
- 相邻代次共享短 TAT 命令互斥锁，准备、探测、安装命令派发与空闲停止不能交叉下发。每次准备/安装派发前重新核验当前归属和 Sandbox；等锁后不使用旧实体快照。
- 身份变化/失效或编排失败停止本地推进；GET 不自动重试。新 POST 是重新准备意图，不是重新发送聊天消息。
- 关闭面板不停止桌面或 Agent。旧空闲回收仍只停止桌面四个 unit，不停止主 Sandbox。新资源 GET 不充当观看 heartbeat；实际 viewer 的续期政策留给后续 attachment owner。

## 后端只读观看链路（尚未接通会话授权 API）

按需安装脚本额外写入 `vela-desktop-observer.service`，与原四个 unit 使用同一 `agentuser` 和 `DISPLAY=:1`。原 Ubuntu/Debian 与 TencentOS 4.4 包安装分支不变；旧 provision 仍只启动原四个 unit，不自动启动/enable 观看服务。新 `desktop/resource` 的显式准备在 HTTP 探测成功后，使用同一命令锁与归属复核安装并启动只读 observer 和下述核验代理，包含预装镜像的升级路径；不 enable、不重启原桌面或 Agent。需要既有 `/usr/bin/python3`（websockify 的运行依赖）；缺少时失败，不偷偷添加第三套安装分支。空闲停止命令包含两个可选观看 unit，但不停止主 Sandbox。

独立 x11vnc 入口固定回环 TCP 5901，原生 `-viewonly` 拒绝键盘/鼠标；`-nosel` 停止全部 X selection/cutbuffer 交换，而不是只用不能阻止写入的 `-noclipboard`。`-norc/-noremote/-nocmds/-novncconnect` 禁用用户 rc、VNC 远程配置/命令与反向连接。没有添加 websockify、公网端口或返回旧密码。

此回环端口使用 `-nopw`，不意味着匿名公开观看。安全前提是它仅供后端授权 broker 访问：本机进程和已经拥有任意 TAT TCP 能力的主体仍可读取它。当前没有会话授权公共路由；不允许将原始 TAT 凭据下发页面以“代替”观看授权，也不因文件已安装而发布 capability。

Sandbox provider 的 `OpenDesktopObserver` 创建后端独占物理 TAT socket，只打开 `127.0.0.1:5901`，不接受任意地址/端口或 shell。原始 StartSession 结果留在后端；同一实例的两名 viewer 也有独立 socket，关闭一条不影响 Chat 或另一条。握手包括 StartSession 有总时间窗，不重试未知结果；二进制数据按序保留，单帧 1MiB、写入分块 64KiB、无无限接收队列，写入有截止时间。关闭/取消先退休自身 socket，再解除 pipe 背压。

直接 `OpenDesktopObserver` 仍只是传输原语，不能作为可信物理进程证明。新的 `InspectDesktopObserver` / `OpenVerifiedDesktopObserver` 只消费固定 5902 核验代理，禁止通过配置退回直接 5901 或旧 5900。生产 broker 仍须从权威记录核验 Conversation/Server/Instance、绑定代次、attachment 到期/撤权，再消费核验通道。也未提供观看 heartbeat、弱网恢复或人工/Agent 控制仲裁；只读 endpoint 不允许原地变为控制模式。

### 原生核验代理

`desktop_observer_proxy.py` 是 CTL 编译时嵌入的唯一源码，资源准备落为 root 所有的 `/usr/local/libexec/opencraft/desktop-observer.py`。独立 `opencraft-desktop-observer-proxy.service` 以 root 检查 `/proc`，仅监听 `127.0.0.1:5902`；启用 NoNewPrivileges、只读系统/家目录、限额及限定能力，不接受环境变量或启动参数指定目标。不是新的输入执行器。

每次连接从 systemd 取得 Xvfb/observer 的 MainPID 和 InvocationID，校验实际 executable 的 root 所有权/不可写权限、进程 UID 和精确 argv。X11 Unix socket 的 SO_PEERCRED 必须属于对应 Xvfb；TCP 握手后有界等候 accept，反向四元组对应的 established socket inode 必须属于同一个 x11vnc PID。先验证再连接后复验，防止只检查监听地址。准备文件使用 root 私有 staging 与新 inode 替换；源/观看 unit 变化时只重启相应观察服务，未变化则复用，不重启原四 unit。

物理 incarnation 来自 boot ID、两进程 PID/start ticks/executable inode 和 systemd invocation 的摘要；不是 CTL job generation。代理每秒复验物理身份，变化、进程死亡或核验失败关闭旧连接。不停止远端桌面或其他 viewer。native `-viewonly/-nosel` 仍是输入/剪贴板门禁，代理不解析或改写 RFB。

代理启动时生成仅 root 可读的 32 字节 `/run/opencraft-desktop-observer/key`，由 systemd 的 0700 RuntimeDirectory 管理，重启失效。后端仅通过固定 TAT root 命令读取，不返回或记录输出。每条连接先发新随机 nonce，代理返回有界身份头及 HMAC；后端校验 nonce、MAC、只读标记及预期 incarnation，剥离身份头后才交接 RFB。此机制拒绝本机普通进程占位后重放旧证明；不宣称抵御拥有 root、等价 TAT 权限或已控制执行主机的攻击者。

挑战首帧最多 256 字节、绝对 3 秒；身份头最多 512 字节。代理最多 32 个连接，双向各 64KiB 缓冲并背压；有待发送数据却无进展 30 秒时回收，静态画面无流量不会被当作失败。后端总打开预算 15 秒；成功后的 viewer 生命周期独立于打开 context，取消/迟到失败只关闭自身物理 socket，不盲重发未知 TAT 结果。Inspect 使用新连接后即关闭，不启动服务或续期。

当前 CTL 只有用户→实例→Sandbox 的权威 DAO，没有 OpenCraft Conversation→Server 的后端授权记录；OpenCraft 的 Server provenance 仍是客户端 legacy Host 投影。不能将页面填写的四个 ID 当作该记录。生产 Authority/公共路由组合仍未完成，插件入口继续隐藏。

源依据：[x11vnc 官方选项实现](https://github.com/LibVNC/x11vnc/blob/master/src/help.c)。本机隔离原生验收使用新分配的 Xvfb display 和临时 VNC 端口，测试原始 RFB 客户端绕过 UI 强行输入，并以去除只读选项的服务作负对照；不触及系统桌面或真实账号。TAT 验证仍为本机 WebSocket/BSON 替身，不是云上验收。

## 明确限制

缓存、幂等与命令锁均为 CTL 进程内机制，未持久化到数据库/Temporal，不能保证跨副本唯一执行或 CTL 重启续跑。模型归属读取与远端 TAT 之间也不是分布式原子事务。已派发的命令/远端 nohup 安装无法靠 HTTP abort 撤回；安装脚本原有远端文件锁仍负责安装互斥。本阶段不声称即时远端撤权。

没有提供“控制租约 REST 空壳”：输入控制必须与实际媒体输入执行器共同实现服务器仲裁、租约撤销后拒绝输入以及人工与 Agent 的仲裁，不能靠前端 view-only 完成。

Ubuntu 与 TencentOS 4.4 的包安装分支仍消费同一安装脚本生成器、unit 和进度协议。本接口不新增第三套安装流程。

## 公共路径与发布

本轮没有改 GitOps 配置。北京两个 sandbox、bj-7、shprod、sgprod 的精确 `path_allow` 目前不包含新 resource 路径；测试证明公共 handler 返回 404。日本、韩国测试环境的实例路由没有精确 path policy，匿名请求进入鉴权返回 401；因此发布新版 CTL 时不能假定它们会因缺少精确规则而挡住新路径。

发布前须确认目标环境的 method/path、鉴权、实名策略及内部 CTL 网络边界。Gateway 正向测试只使用测试内存里的精确规则，验证认证用户覆盖伪造用户头、POST 202/GET 200 透传和相邻 method 拒绝，不表示已部署公开接口。

OpenCraft 生产 adapter 尚未提供 Conversation → Server → CTL Instance 的真实授权解析、媒体进程和 viewer/input lease，因此桌面插件入口继续隐藏。

## 验证

CTL desktop 单测覆盖纯观察、请求取消不终止准备、并发合并、无需 GET 的安装推进、嵌套探测锁回归、换机迟到命令、账户变更和失败重试记录隔离。API router 测试覆盖身份、归属失败、200/202 与无凭据 DTO；Gateway 测试覆盖实际环境策略差异和合成精确规则。

`OPENCRAFT_DESKTOP_NATIVE_TEST=1 go test -race ./pkg/instance -run 'TestDesktopObserver'` 验证独立 Xvfb/x11vnc、原生输入正负对照与核验代理；root 验证器/非 root 桌面使用既有 nobody 的隔离进程，不创建用户，不启动 systemd unit。只有 systemd PID 发现为替身；实际进程、TCP inode、X11 peer credentials、MAC、原始 RFB 与失效回收是真实系统路径。
Sandbox 的 `OPENCRAFT_DESKTOP_NATIVE_TEST=1 GOWORK=off go test -race ./internal/provider -run TestVerifiedObserverNativeThroughTATWire` 将 Go 后端接到同一真实 Python 核验代理/x11vnc，经替身 WS/BSON 云边界验证双向字节、身份检查与打开/观看寿命分离。两个测试均不读取实际 runtime key，使用明确的合成材料；不证明真实 TAT、systemd hardening 或云上安装。

这些测试不能替代真实 TAT、云端安装、媒体、设备输入、多副本或生产授权验收。
