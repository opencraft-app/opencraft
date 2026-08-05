# Vela Computer LaunchAgent 加载验收设计

## 背景

Vela Computer v0.1.39 在 macOS 替换安装后打印“无法确认 Vela Computer LaunchAgent 已启动”，但现场证据显示安装已经成功：launchd 中的服务使用正确 plist 和二进制，状态为 running，进程从未退出，daemon 状态为 online/healthy。

当前安装器在 `bootstrap` 成功后，要求三秒内连续两次观察到相同的 running PID。这个条件把两个独立事实混在了一起：

1. 安装事务是否已把正确 LaunchAgent 交给 launchd；
2. daemon 是否已经启动并连接平台。

launchd 可以延迟调度 KeepAlive 进程，因此第二个事实不应决定第一个事实是否成功。三秒同步运行确认会产生假失败，也会让安装命令承担本应属于在线投影的职责。

## 目标

- 安装成功只表示 launchd 已加载身份正确的 LaunchAgent。
- daemon 在线仍由现有 daemon 心跳和平台 lease 投影决定。
- 不接受错误 plist、错误二进制或未加载服务。
- 不延长安装等待时间，不新增第二套 daemon 状态判断。
- 首次安装与替换安装使用相同验收语义。

## 非目标

- 不改变 LaunchAgent 的 KeepAlive、RunAtLoad、日志或业务运行参数；唯一新增项是通用包注入的只读 definition fingerprint 环境元数据，daemon 不用它驱动业务行为。
- 不改变 Computer 在线状态、心跳、TAT 或腾讯 IM 逻辑。
- 不让安装器等待平台页面显示在线。
- 不新增 `kickstart`，也不读取 daemon state 文件作为安装成功依据。

## 设计

### 独立 launchd 能力

launchd 生命周期不再实现在 `internal/vela/install`。新增独立的 macOS 用户服务包 `internal/launchd`，其领域只包含：

- 用户 LaunchAgent 的通用定义：label、program、arguments、stdout/stderr、environment、KeepAlive、RunAtLoad、ProcessType 和 umask；
- plist 的安全生成与原子落盘；
- 当前用户 launchd domain 的 bootout、bootstrap 和最终加载身份观察；
- path、program、arguments 的严格身份匹配；
- LaunchAgents 目录 ownership、mode、symlink 和普通文件安全检查。

通用包不得引用 Vela Computer、安装事务、平台 URL、Computer credential、TAT 或 IM。它提供面向收敛的 `EnsureLoaded(ctx, Definition)` 能力：调用成功只表示 launchd 已加载与 Definition 完整一致的服务；重复调用产生相同结果。

`EnsureLoaded` 按真实资源键 `(uid, label)` 自己串行化。除进程内互斥外，还在受保护的 LaunchAgents 目录创建每 label 一个持久 `0600` 普通锁文件并持有跨进程 advisory lock，覆盖 fast path、plist 写入、bootout、bootstrap 和最终观察全过程。锁文件使用 no-follow/等价安全打开并经 fstat 验证为当前 uid 所有、`0600`、普通文件；解锁后永久保留而不 unlink，防止不同调用方锁住不同 inode。Vela 的 `install.lock` 只保护安装事务自身，不能替代通用 launchd 资源锁。

进程内锁和 advisory lock 都必须可取消获取：等待者根据 `ctx` 使用非阻塞尝试与短轮询，deadline/cancel 后返回稳定的 canceled/timeout 领域错误，且在取得完整资源锁前不得写 plist 或执行 launchctl。

Definition 的通用契约为：

- label 仅允许非空 ASCII 字母、数字、点、连字符和下划线，不允许 `/`、`..`、控制字符或 domain 分隔符；
- program、stdout 和 stderr 必须是 clean 的绝对路径，不允许 NUL；
- arguments 只表示 program 后的参数，渲染和观察时由通用包把 program 作为 argv[0]；每项不得含 NUL；
- environment key 必须是合法变量名，value 不得含 NUL；所有字符串由 XML encoder 转义；
- program SHA-256 是调用方提供的 64 位小写十六进制内容标识；Vela install 必须使用已验签并已落盘程序的 SHA-256，而不是路径或版本文案；
- ProcessType 只接受 launchd 明确支持的枚举，umask 必须处于 Unix 权限位范围，KeepAlive 与 RunAtLoad 是显式布尔值；
- 所有 Definition 校验必须发生在创建锁文件、写 plist 或执行 launchctl 之前，非法输入零副作用失败。

通用包取得 `(uid,label)` 资源锁后、执行任何 plist 或 launchctl 副作用前，必须打开 Definition.Program 的当前普通文件并计算实际 SHA-256；只有与声明值完全一致才可继续。Vela 的安装锁和原子程序替换保证安装调用方不会在此期间主动换回另一代程序；同一 macOS uid 下的恶意进程仍不属于隔离边界。声明 SHA 与磁盘程序不一致时返回 Definition 领域错误且保持 launchd 零副作用。

通用包只返回稳定的领域错误和必要的失败阶段，不产生任何 Vela 文案。`internal/vela/install` 适配器负责把领域错误映射为面向用户的 Computer 安装错误。

`internal/vela/install` 仅保留一个薄适配器，实现现有 `Launcher` 端口：把 `LaunchSpec` 转换为通用 Definition，并设置 Computer 固定参数、日志路径及 PATH。安装服务继续只依赖 `Launcher` 接口，因此安装事务测试不需要理解 launchctl。

首版只抽取当前实际需要的 ensure-loaded 能力，不提前增加 stop、restart、list、system daemon 或 root domain API。未来若出现其他 macOS 常驻能力，可直接复用通用包并独立扩展。

生产实现只在 Darwin 编译。launchctl command runner、home/uid/gid resolver 和轮询 deadline/interval 通过包内构造依赖替换；测试使用临时目录和假的 runner，不触碰真实用户 LaunchAgents。非 Darwin 的 Vela 构建继续使用现有平台边界，不得因为新增包产生 build failure。

`EnsureLoaded` 是幂等收敛操作，不承诺事务回滚。若写入期望 plist 后在 bootout、bootstrap 或观察阶段失败，期望 plist 会保留，旧 job 可能已退出，新 job 状态由返回的领域错误阶段说明；调用方可以安全重试同一 Definition。通用包不会恢复旧 plist，因为旧 plist 可能引用已经被调用方替换的二进制或状态，伪回滚反而不安全。

通用包对包含 program SHA-256 在内的完整 Definition 计算 canonical SHA-256 fingerprint，并通过一个包保留、调用方不得覆盖的环境字段写入 plist。Definition.Environment 若设置该保留 key，必须在零副作用校验阶段拒绝，避免覆盖或 fingerprint 自引用。该字段必须能从 `launchctl print` 的 environment 观察。二进制内容、arguments、日志路径、environment、KeepAlive、RunAtLoad、ProcessType 或 umask任一变化都会产生不同 fingerprint。

持有完整资源锁后先执行无副作用 fast path：渲染 Definition 的 canonical plist，安全读取磁盘 plist并要求字节一致，同时观察 launchd loaded identity 的 path、program、arguments 和 fingerprint 完全一致；全部满足则立即成功，不写文件、不 bootout、不 bootstrap。只有磁盘定义或 loaded generation 不一致时才进入收敛替换流程。因此同一 Definition 的重复调用不会重启健康 daemon，而同 program path 覆盖新二进制时因 program generation 改变必然重载。

### LaunchAgent 身份观察

继续使用 `launchctl print gui/<uid>/<label>`，只接受同时满足以下条件的观察：

- `path` 是本次写入的 canonical plist 路径；
- `program` 是本次安装的 canonical `vela-computer` 路径；
- `arguments` 与本次写入的 canonical 参数完全一致：`<program> daemon run --state-dir <state-dir>`；
- 保留环境字段中的 definition fingerprint 与本次 Definition 完全一致；
- 两个路径都是绝对路径；
- `launchctl print` 成功，表示服务已被当前用户的 launchd domain 加载。

`state` 和 `pid` 可以保留为诊断信息，但不再是安装成功条件。launchd 已加载正确 KeepAlive 服务后，即使 daemon 尚处于调度、启动或重启窗口，安装事务也应成功结束。

身份观察依赖既有安全不变量：通用包持有 `(uid,label)` 资源锁；`~/Library/LaunchAgents` 必须是当前 uid 所有的真实目录（非 symlink），权限只能是 `0700` 或 `0755`，不得 group/world writable；plist 临时文件通过不可抢占的独占创建语义生成，确认是当前 uid 的 `0600` 普通文件后写入、fsync，再原子改名并同步父目录，目标不会作为 symlink 跟随。Vela 不把同一 macOS 用户下的恶意本地进程视为隔离边界，但会用 launchd 返回的 path、program 和完整 arguments 防止错误服务或旧参数被误认成本次安装。

### 启动流程

流程保持为：

1. 校验 Definition 并取得可取消的 `(uid,label)` 资源锁；
2. 若磁盘 canonical plist 与 launchd loaded identity/generation 均已匹配，直接成功；
3. 否则原子写入 plist；
4. `bootout` 旧服务；首次安装返回 service-not-found 是正常幂等结果；
5. 以结果为准等待旧服务从 launchd domain 消失；即使 `bootout` 返回其他错误，只要服务确已消失即可继续，若仍存在则失败；
6. `bootstrap` 新 plist；
7. 轮询 `launchctl print`，直到观察到完整正确身份：path、program、arguments 和 definition fingerprint；
8. 返回安装成功。

`bootstrap` 命令的退出状态不是最终事实：无论它返回 I/O error 或其他错误，只要随后能观察到完整身份正确的已加载服务，均视为成功。如果在当前三秒边界内始终没有正确身份观察，则返回原有注册/确认错误。这样不会对 launchctl 的具体错误文本建立脆弱白名单。

### 在线语义

安装器不写“在线”结论。daemon 启动后继续通过既有 Computer session、heartbeat 和 lease 更新平台投影。这样 UI 的 online 只代表真实控制面连接，不会因安装命令成功而提前变更。

## 错误处理

- `launchctl print` 不存在：继续短轮询，超时后失败。
- plist、program、完整 arguments 或 definition fingerprint 不匹配：立即失败，防止接受被替换、旧代、旧参数或串线的服务。
- `bootstrap` 失败但正确服务已加载：成功。
- `bootstrap` 失败且服务未加载：返回包含 launchctl 原始摘要的注册错误。
- `bootstrap` 成功但服务未加载：返回“Unable to verify that Vela Computer was registered with macOS.”。
- 成功文案使用 `Computer installed and registered with macOS.` 或 `Computer replaced and registered with macOS.`，不再承诺 daemon 已经 running。

## 测试

采用测试驱动修改：

1. 先增加失败测试：`bootstrap` 成功，`launchctl print` 返回正确 path/program/arguments/fingerprint，但没有 running state 和 PID；预期安装成功。当前实现会超时失败。
2. 增加首次安装测试：旧服务不存在时 `bootout` 的 not-found 结果必须幂等继续，并加载新服务。
3. 覆盖 `bootstrap` I/O error 和非 I/O error 后观察到完整正确身份时均成功。
4. 覆盖 `bootstrap` 任意错误后未加载、错误 plist、错误 program、错误 arguments、缺失/错误 fingerprint 或相对路径时失败。
5. 保留 bootout 完成后才验收替换服务的顺序测试。
6. 更新调用序列断言，不再要求连续两次相同 PID。
7. 更新首装、替换成功文案测试，确保不再承诺 running。
8. 保留或补齐安全前置测试：同 `(uid,label)` 的不同 Manager/调用方必须跨进程锁语义串行化；锁文件安全打开、验证并持久保留，多个 Manager 连续交接不得产生 inode split；等待进程内锁或 advisory lock 时取消必须零 plist/launchctl 副作用；错误 owner、group/world writable 或 symlink 的 LaunchAgents 目录必须拒绝；plist 必须以 `0600` 普通文件完成原子替换，launchd 观察必须对应替换后的完整身份。
9. 通用 `internal/launchd` 包覆盖 Definition 非法输入零副作用、声明 SHA 与磁盘程序不匹配零副作用、调用方覆盖保留 environment key 拒绝、XML 转义、fingerprint、plist 渲染、命令顺序、loaded 身份、bootstrap 错误降级、失败阶段和失败后同 Definition 重试；同 Definition 二次调用必须走 fast path且不写 plist、不 bootout、不 bootstrap；相同 program path 但不同 program SHA 必须重载；新 plist 写入后、bootout 前失败且只有非 path 字段变化，重试也不得误走 fast path。Vela install 适配器只覆盖 Definition 映射、已验签程序 SHA、领域错误文案映射与不携带凭据。
10. 增加 Darwin 构建/测试和非 Darwin 编译门禁。
11. 运行 launchd/install 包测试、Agent 全量测试和 vet。

## 发布与验收

- 发布为不可变 Computer v0.1.40。
- 使用新 16 位安装码执行替换安装。
- 命令应快速返回 `Computer replaced and registered with macOS.`，不再出现同步运行误判。
- `launchctl print` 必须显示正确 path、program、完整 arguments 和本次 definition fingerprint；daemon 随后通过心跳使页面显示在线。
- 验证 Computer catalog、程序摘要、后台 3/3 Ready 和零重启。
