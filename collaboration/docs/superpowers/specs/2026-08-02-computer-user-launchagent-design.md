# Computer 用户级 LaunchAgent 设计

## 目标

macOS Computer 以当前自然人账户安装和运行。整个产品路径不请求管理员权限，不执行
`sudo`，不写 `/Library`，也不以 root 身份启动 Computer、内嵌 TAT Bridge、Agent
Runtime 或 PTY。

首版目标平台仍为 `darwin-arm64`。用户登录后 Computer 自动上线；退出登录后停止，
不承诺在登录窗口、无用户会话或 FileVault 解锁前在线。

## 用户可见行为

平台生成的一行安装命令只完成以下工作：

1. 在 `0700` 临时目录下载并校验发布安装器；
2. 安装器再次下载并验证签名 manifest 与 Computer 程序；
3. 将程序和私有状态安装到当前用户目录；
4. 使用一次性 enrollment token 完成 claim 和托管实例注册；
5. 写入用户级 LaunchAgent 并立即启动 Computer；
6. 输出“Computer 已连接”，不显示腾讯云 Region、TAT 注册材料或内部资源名。

安装命令、安装器和 Computer 程序均不得调用 `sudo`。若由 root 执行，安装器明确拒绝，
防止把 root 的 Home 误认为实际用户目录。

## 文件与进程拓扑

```text
~/Library/Application Support/AgentNetwork/Computer/
├── bin/chatserver-computer
├── locks/enrollment.lock
├── state/
│   ├── enrollment.json
│   ├── computer-home/
│   ├── tat/
│   └── logs/
└── releases/

~/Library/LaunchAgents/build.raft.agent-network.computer.plist
```

根目录、状态目录和临时凭证目录使用 `0700`；凭证与 token 文件使用 `0600`；程序使用
`0700`；plist 使用 `0600`。所有文件归当前有效 UID/GID 所有，不执行跨用户 `chown`。

LaunchAgent 运行：

```text
chatserver-computer daemon
  --installation-root <用户目录绝对路径>
  --state-dir <用户状态目录绝对路径>
  --handoff-nonce <非秘密随机值>
  --program-sha256 <已验证程序摘要>
```

plist 不包含 `UserName`、enrollment token、Computer credential、腾讯注册材料或其他
秘密。`RunAtLoad=true`、`KeepAlive=true`；环境只保留固定系统 PATH。日志写入私有状态
目录并经过凭证脱敏。

## launchd 生命周期

安装器仅操作当前用户的 GUI domain：

```text
launchctl bootstrap gui/<uid> <plist>
launchctl kickstart -k gui/<uid>/build.raft.agent-network.computer
```

若同一 label 已加载，则先验证它属于当前 GUI domain 和预期 plist，再进行幂等更新与
kickstart；不得操作 `system` domain。当前没有可用 GUI session 时，保留已验证安装和
本地 enrollment 进度，返回可诊断错误；用户登录桌面后重跑命令可安全继续。

安装进程和 LaunchAgent 继续使用现有 enrollment lock、program hash、handoff nonce
与 launch fencing，避免并发安装、半升级及旧进程接管新状态。锁文件 owner 改为当前
UID，不再承担 root 到普通用户的权限交接。

## 升级与失败恢复

- `0.1.0` 已发布且不可覆盖；无 root 版本发布为新的不可变版本 `0.1.1`。
- 程序仍以临时文件、同步和原子改名更新；验证失败时不替换现有程序。
- claim、provider 注册或 launchctl 失败均保留可幂等恢复的阶段状态，但删除一次性明文
  注册材料和临时下载文件。
- 重跑同一有效安装命令不会创建第二个 Computer、第二个 provider 身份或第二个
  LaunchAgent。
- 不修改机器上已有的腾讯 TAT 系统 Agent，也不接管任何 `/Library` 下的旧状态。

## 验收门禁

自动测试必须先证明旧实现失败，再实现以下行为：

- setup command、安装器、plist 和 Go 源码的产品路径均不含 `sudo`、
  `/Library/LaunchDaemons` 或 `launchctl ... system`；
- 默认安装根和 plist 都位于当前用户目录；root 调用被拒绝；
- plist 不含 `UserName` 和秘密，launchctl 只访问 `gui/<uid>`；
- 首装、重复安装、崩溃恢复、程序升级、并发执行和旧 launch 输出 fencing 均通过；
- LaunchAgent 实际 UID 等于安装用户，Computer、TAT Bridge、Agent Runtime 与 PTY
  均不是 root；
- 登录会话中安装后 Computer online，手动终止后由 LaunchAgent 恢复；退出登录不要求
  保持在线；
- 全仓测试、race、vet、生成漂移和凭证扫描通过。

临时 Canary 自签名根证书不属于产品设计。正式验收使用系统已信任的 HTTPS 域名；当前
系统钥匙串中的临时证书作为独立环境遗留处理，不允许安装器创建或信任证书。
