# TAT 与 Computer 执行面

## 1. 固定边界

Platform v1 只发布一个 macOS ARM64 端侧程序：`raft-computer-go`。它以当前登录用户
运行，不需要 Root；腾讯 TAT 以 Rust staticlib 经 CGO 链入同一进程，腾讯 IM SDK 以
Goja + 单文件 JavaScript 链入同一进程。

机器上不存在独立 TAT、Node、IM Bridge、每 Agent Manager 或旧 Raft runner 进程。Codex、
Hermes 等模型 Runtime 仍可按 Agent 配置作为受控子进程启动。

```text
Chatserver
  ├── HTTPS：Computer Session、Assignment 长轮询、Heartbeat
  ├── 腾讯云 TAT API：命令、PTY、状态查询
  └── 腾讯云 IM 管理 API：身份与短期 UserSig
          │
          ▼
raft-computer-go daemon run
  ├── 内嵌 TAT core ↔ 腾讯 TAT wire
  ├── RuntimeActor × N
  └── 内嵌 LiteChat ↔ 腾讯 IM wire
```

TAT 不承载 Agent Assignment。Assignment 由 Computer 使用短期平台 Session 通过 HTTPS
长轮询取得；TAT 负责通用机器控制、远程终端和托管实例在线能力；Agent 聊天数据面直连
腾讯 IM。

## 2. 首次安装与注册

1. 用户在 Web 创建 Computer，后台签发一次性短码。
2. 安装入口下载 `install.sh`、manifest、签名和 `raft-computer-go`，并校验固定 SHA-256。
3. 二进制再次校验 Ed25519 manifest、版本、target、程序大小与 SHA-256。
4. 二进制用短码 claim Computer，原子写入 Computer credential；短码和安装期随机材料随即
   删除。
5. 后台调用腾讯云 `CreateRegisterCode`，返回一次性的 region、CodeID、CodeValue 和唯一
   `agent-network-computer-id=<computerID>` 标签。
6. 二进制把注册材料直接交给内嵌 TAT C ABI；不执行后台下发的 shell，不生成第二个程序。
7. 后台按稳定标签绑定唯一 `rins-*` 托管实例。
8. 安装器写入用户级 LaunchAgent 并启动 `raft-computer-go daemon run`。

首次安装只有一个小型 crash-safe journal，用于同一次安装失败后的安全续跑。项目尚未发布，
不存在旧 Computer 或旧 Agent，不读取旧状态、不迁移旧版本，也不提供模式兼容入口。

## 3. 本地布局

```text
~/.vela/
├── bin/raft-computer-go
├── state/
│   ├── config.json
│   ├── computer.credential
│   ├── computer.credential.meta.json
│   ├── tat/
│   ├── agents/
│   ├── logs/
│   └── management.sock
└── workspaces/<agentID>/

~/Library/LaunchAgents/com.agentnetwork.vela.computer.plist
```

目录权限为 `0700`，credential/token 文件为 `0600`；敏感写入使用临时文件、同步与原子
改名。旧开发目录不读取、不迁移，也不自动删除。

## 4. 身份与凭据

- Chatserver 持有部署级腾讯云 CAM 权限；Computer、Human、Agent 均不持有 CAM 密钥或 IM
  管理员密钥。
- Computer credential 只用于换取短期 Computer Session。
- 每个 Agent credential 只用于换取该 Agent 的短期 Runtime Session 和 UserSig。
- TAT 注册码、UserSig、capability token 和 credential 不进入命令行、日志、测试夹具或
  发布物。
- 后台按 `server_id` 做业务授权，按 `(tat_region, tat_instance_id)` 唯一定位 TAT 资源。

## 5. 运行与故障语义

- daemon 启动后先启动内嵌 TAT，再长轮询 Assignment；接受的 snapshot 以 epoch、revision、
  config generation 和 credential version 做 fencing。
- 每个 Agent 由一个 RuntimeActor 管理；共享 Gateway 只监听回环地址。
- Agent 通过自己的 UserSig 直连腾讯 IM；消息正文和历史不复制到 Chatserver。
- daemon 定期上报 TAT 状态、Assignment revision、Agent launch fence 和 reconcile 结果。
- 平台 Session 失效时重新签发；Computer credential 被撤销后停止继续工作。
- TAT、Assignment、IM 或 Runtime 的单点短暂失败分别重试，不能把单条消息处理错误升级为
  整个 IM 连接失败。

## 6. 验收

- macOS ARM64 产物只依赖系统动态库，TAT staticlib 已进入 Mach-O。
- 新 Computer 可完成短码安装、TAT `rins-*` 绑定、LaunchAgent 启动和在线 heartbeat。
- 后台可通过 TAT 执行命令并建立 PTY。
- Assignment 可启动多个 Agent；每个 Agent 用自己的 UserSig 登录 IM。
- DM、Topic mention、Runtime 回复、未读历史恢复和去重闭环通过。
- 杀掉 daemon、Runtime 或网络连接后可恢复，旧 launch 输出不会污染当前 Agent。

