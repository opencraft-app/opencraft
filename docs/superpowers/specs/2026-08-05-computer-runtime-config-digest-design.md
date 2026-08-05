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

安装器根据以下非敏感、规范化字段计算 SHA-256：

- `platformUrl`
- `serverId`
- `computerId`
- `stateDirectory`

结果作为 `LaunchSpec.RuntimeConfigDigest` 传给 macOS launcher，再作为
`launchd.Definition.RuntimeConfigDigest` 纳入现有 definition fingerprint。plist 仍只保存最终
definition fingerprint，不保存上述字段或额外身份信息；daemon 无需读取该摘要。

首次安装、替换安装和已提交替换的恢复路径都从已经落盘并校验过的安装日志构造相同摘要。
同一 Computer 重试得到同一摘要，继续走 fast path；Computer 替换得到不同摘要，现有
`bootout → bootstrap → observe` 流程会重启进程。

`RuntimeConfigDigest` 必须是小写 64 位十六进制 SHA-256。缺失或非法时拒绝 launchd 定义，
避免调用方退回无法识别配置变化的旧语义。

## 验收

- 二进制、参数和路径均相同，仅 Runtime Config Digest 改变时执行重载；
- Runtime Config Digest 相同时只执行一次 `launchctl print`，不重载；
- 替换安装传递新 Computer 对应的摘要；恢复同一替换传递相同摘要；
- plist 和日志不包含 Credential、token 或 secret；
- 安装完成后 launchd 进程的 Computer ID 与落盘配置一致，并能取得 Session、更新在线租约；
- macOS 单元测试、Agent 全量测试和真实 Canary 替换验收通过。
