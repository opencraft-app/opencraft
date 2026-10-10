# Computer Runtime Config Digest 设计

## 问题

Computer 替换会原子写入新的 `serverId`、`computerId` 和 Credential，但安装路径、
二进制及 launchd plist 的静态参数可能完全不变。当前 launchd 管理器因此走无副作用快路，
让旧进程继续使用替换前的配置；安装器却已经返回注册成功。

## 目标

把“当前运行进程应读取哪一份非敏感配置”纳入 launchd 的幂等定义：

- 配置身份变化时必须重新加载进程；
- 相同配置的重复执行不得无故重启；
- 不新增数据库字段、后台接口、持久化计数器或 daemon 状态机；
- Credential、token 及其可验证摘要不得写入 plist。

## 设计

安装器从已经校验的 `installJournal + Options` 构造唯一的 activation snapshot：

- schema/domain separator：`vela-computer-runtime-config/v1`
- `platformUrl`：复用 `normalizeInstallBaseURL` 的结果；URL 必须无 userinfo、query 和 fragment
- `serverId`
- `computerId`
- `credentialId` 与十进制 `credentialVersion`，不接收 Credential secret 或其摘要
- `stateDirectory`：必须是经过 `filepath.Clean` 且保持不变的绝对路径

摘要输入采用固定字段顺序和 uint64 大端长度前缀，不使用字符串拼接。由此避免字段边界
碰撞，语义等价的 URL 也得到相同结果。Credential 单独轮换会改变公开 ID 或版本，因而即使
daemon 只在启动时读取 Credential，也会触发重新加载。

结果作为 `LaunchSpec.RuntimeConfigDigest` 传给 macOS launcher，再作为
`launchd.Definition.RuntimeConfigDigest` 纳入现有 definition fingerprint。plist 仍只保存最终
definition fingerprint，不保存上述字段或额外身份信息；daemon 无需读取该摘要。

首次安装、替换安装和已提交替换的恢复路径都调用同一个 snapshot/digest 构造函数。
同一 activation 重试得到同一摘要，继续走 fast path；Computer 或 Credential 替换得到不同摘要，现有
`bootout → bootstrap → observe` 流程会重启进程。

`RuntimeConfigDigest` 必须是小写 64 位十六进制 SHA-256。缺失或非法时拒绝 launchd 定义，
避免调用方退回无法识别配置变化的旧语义。

## 原子性与恢复

现有 `state/install.lock` 从读取 journal 开始一直持有到 `EnsureLoaded` 返回，继续作为唯一的
安装串行化边界。不得在锁外计算或应用 digest。

activation snapshot 同时驱动 `config.json`、`computer.credential.meta.json` 和 digest，避免
各自重新组装。状态文件继续使用 `Store.Write` 的临时文件、fsync、rename 和目录 fsync。
Credential、config 和 meta 全部落盘后才调用 `EnsureLoaded`，成功观察到新 definition 后才把
journal 写成 `complete`。替换恢复不能只相信 journal；继续校验实际 Credential route、config
和 credential meta 都与 journal 一致，不一致则从未完成的 replacement journal 重放写入与启动。

运行期的安全提交点是 Credential 与 config 的 route 一致性，而不是跨文件原子 rename：旧 daemon
只在启动时读取一次这两份文件，不会在写入窗口热读；若它恰好退出并被 KeepAlive 拉起，controller
必须先验证 Credential 中的 `serverId/computerId` 与 config 完全一致，不一致就拒绝建连并退出，
由 launchd 在状态写完后重试。credential meta 不参与 daemon 建连。测试在每个写入点模拟启动，
只允许旧 activation、新 activation 或显式 `ErrComputerStateInvalid`，不得产生混合身份 Session。

同一 state directory 的完整流程持有同一个排他文件锁，两个安装/替换不能交错写配置或回写较旧
fingerprint。不同 state directory 的文件彼此隔离；相同 `(uid,label)` 的最终 launchd 切换由现有
`~/Library/LaunchAgents/.<label>.plist.lock` 串行化，最后一次完整切换决定运行目录，不会读取另一
目录的半成品。安装器不支持在同一命令中改变 state directory；每个目录的 journal 都只接受与
其原始 Options 一致的恢复，否则返回冲突。

`validOptions` 强制 `stateDirectory = installationRoot/state`，安装目标也固定为
`installationRoot/bin/vela-computer`。因此不同 state directory 必然对应不同 program path，不能
覆盖对方已经验签的二进制；相同 program path 则必然共享同一个 install lock。launchd manager 又在
label 锁内执行 program hash 校验、plist 写入、bootout、bootstrap 和观察，消除“验签后被另一安装
覆盖”的窗口。

首次安装在任何 activation 文件写入前已有 `staged` journal；替换安装在写入前已有 fsync 完成的
replacement journal。恢复以对应 pending journal 为权威，只在 Platform URL、release、target、
Server、Computer 与调用 Options 一致时重放，否则返回冲突。

已有安装的 Platform URL 不允许改变：`replaceComplete` 和 replacement 恢复都必须在修改任何
文件前确认 `options.PlatformURL == installJournal.PlatformURL`，否则返回冲突。因此多文件替换
窗口只可能改变同一平台下的 Computer/Credential 身份；新的 Platform URL 只能使用新的
installation/state directory 完成首次安装，不会复用旧 Credential。

## 验收

- 二进制、参数和路径均相同，仅 Runtime Config Digest 改变时执行重载；
- Runtime Config Digest 相同时只执行一次 `launchctl print`，不重载；
- snapshot 的任一身份字段变化都改变摘要，字段边界无碰撞；等价 URL 产生相同摘要；
- Credential ID/版本单独变化会改变摘要，摘要 API 不接受 Credential secret；
- 替换安装传递新 activation 对应的摘要；恢复同一替换传递相同摘要；
- 缺失或非法摘要在写 plist 或调用 launchctl 前失败；
- config/meta 写入、journal commit 和 EnsureLoaded 前后的失败均可由现有 journal 恢复；
- 任一多文件写入点发生 KeepAlive 重启时，daemon 只能使用完整 activation 或安全拒绝建连；
- 已有安装改变 Platform URL 必须在任何状态写入前被拒绝，旧 Credential 不得发送到新 URL；
- 同目录并发替换在安装锁下串行化；不同目录的 launchd 切换在 label 锁下线性化；
- 不同目录必然使用不同 program path；相同 program path 的并发安装必然共享 install lock；
- plist 和日志不包含 Credential、token 或 secret；
- 安装完成后 launchd 进程的 Computer ID 与落盘配置一致，并能取得 Session、更新在线租约；
- macOS 单元测试、Agent 全量测试和真实 Canary 替换验收通过。
