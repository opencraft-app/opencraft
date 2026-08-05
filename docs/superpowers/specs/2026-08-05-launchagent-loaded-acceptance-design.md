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

- 不改变 LaunchAgent 的 KeepAlive、RunAtLoad、日志或运行参数。
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

通用包不得引用 Vela Computer、安装事务、平台 URL、Computer credential、TAT 或 IM。它提供面向结果的 `Replace(ctx, Definition)` 能力：调用成功只表示 launchd 已加载完整身份正确的定义。

`internal/vela/install` 仅保留一个薄适配器，实现现有 `Launcher` 端口：把 `LaunchSpec` 转换为通用 Definition，并设置 Computer 固定参数、日志路径及 PATH。安装服务继续只依赖 `Launcher` 接口，因此安装事务测试不需要理解 launchctl。

首版只抽取当前实际需要的 replace/load 能力，不提前增加 stop、restart、list、system daemon 或 root domain API。未来若出现其他 macOS 常驻能力，可直接复用通用包并独立扩展。

### LaunchAgent 身份观察

继续使用 `launchctl print gui/<uid>/<label>`，只接受同时满足以下条件的观察：

- `path` 是本次写入的 canonical plist 路径；
- `program` 是本次安装的 canonical `vela-computer` 路径；
- `arguments` 与本次写入的 canonical 参数完全一致：`<program> daemon run --state-dir <state-dir>`；
- 两个路径都是绝对路径；
- `launchctl print` 成功，表示服务已被当前用户的 launchd domain 加载。

`state` 和 `pid` 可以保留为诊断信息，但不再是安装成功条件。launchd 已加载正确 KeepAlive 服务后，即使 daemon 尚处于调度、启动或重启窗口，安装事务也应成功结束。

身份观察依赖既有安装安全不变量：整个安装或替换过程持有该 state directory 的独占 `install.lock`；`~/Library/LaunchAgents` 必须是当前 uid 所有的真实目录（非 symlink），权限只能是 `0700` 或 `0755`，不得 group/world writable；plist 临时文件通过不可抢占的独占创建语义生成，确认是当前 uid 的 `0600` 普通文件后写入、fsync，再原子改名并同步父目录，目标不会作为 symlink 跟随。Vela 不把同一 macOS 用户下的恶意本地进程视为隔离边界，但会用 launchd 返回的 path、program 和完整 arguments 防止错误服务或旧参数被误认成本次安装。

### 启动流程

流程保持为：

1. 原子写入 plist；
2. `bootout` 旧服务；首次安装返回 service-not-found 是正常幂等结果；
3. 以结果为准等待旧服务从 launchd domain 消失；即使 `bootout` 返回其他错误，只要服务确已消失即可继续，若仍存在则失败；
4. `bootstrap` 新 plist；
5. 轮询 `launchctl print`，直到观察到完整正确身份：path、program 和 arguments；
6. 返回安装成功。

`bootstrap` 命令的退出状态不是最终事实：无论它返回 I/O error 或其他错误，只要随后能观察到完整身份正确的已加载服务，均视为成功。如果在当前三秒边界内始终没有正确身份观察，则返回原有注册/确认错误。这样不会对 launchctl 的具体错误文本建立脆弱白名单。

### 在线语义

安装器不写“在线”结论。daemon 启动后继续通过既有 Computer session、heartbeat 和 lease 更新平台投影。这样 UI 的 online 只代表真实控制面连接，不会因安装命令成功而提前变更。

## 错误处理

- `launchctl print` 不存在：继续短轮询，超时后失败。
- plist、program 或完整 arguments 不匹配：立即失败，防止接受被替换、旧参数或串线的服务。
- `bootstrap` 失败但正确服务已加载：成功。
- `bootstrap` 失败且服务未加载：返回包含 launchctl 原始摘要的注册错误。
- `bootstrap` 成功但服务未加载：返回“Unable to verify that Vela Computer was registered with macOS.”。
- 成功文案使用 `Computer installed and registered with macOS.` 或 `Computer replaced and registered with macOS.`，不再承诺 daemon 已经 running。

## 测试

采用测试驱动修改：

1. 先增加失败测试：`bootstrap` 成功，`launchctl print` 返回正确 path/program/arguments，但没有 running state 和 PID；预期安装成功。当前实现会超时失败。
2. 增加首次安装测试：旧服务不存在时 `bootout` 的 not-found 结果必须幂等继续，并加载新服务。
3. 覆盖 `bootstrap` I/O error 和非 I/O error 后观察到完整正确身份时均成功。
4. 覆盖 `bootstrap` 任意错误后未加载、错误 plist、错误 program、错误 arguments 或相对路径时失败。
5. 保留 bootout 完成后才验收替换服务的顺序测试。
6. 更新调用序列断言，不再要求连续两次相同 PID。
7. 更新首装、替换成功文案测试，确保不再承诺 running。
8. 保留或补齐安全前置测试：安装锁竞争必须串行化；错误 owner、group/world writable 或 symlink 的 LaunchAgents 目录必须拒绝；plist 必须以 `0600` 普通文件完成原子替换，launchd 观察必须对应替换后的完整身份。
9. 通用 `internal/launchd` 包覆盖 plist 渲染、命令顺序、loaded 身份、bootstrap 错误降级和安全目录；Vela install 适配器只覆盖 Definition 映射与不携带凭据。
10. 运行 launchd/install 包测试、Agent 全量测试和 vet。

## 发布与验收

- 发布为不可变 Computer v0.1.40。
- 使用新 16 位安装码执行替换安装。
- 命令应快速返回 `Computer replaced and registered with macOS.`，不再出现同步运行误判。
- `launchctl print` 必须显示正确 path、program 和完整 arguments；daemon 随后通过心跳使页面显示在线。
- 验证 Computer catalog、程序摘要、后台 3/3 Ready 和零重启。
