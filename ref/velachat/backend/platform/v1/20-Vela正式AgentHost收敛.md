# 唯一 Computer Host 契约

状态：Platform v1 正式规格

## 1. 唯一程序与入口

端侧唯一程序为 `vela-computer`，唯一常驻入口为：

```text
vela-computer daemon run
```

程序没有 mode 选择器、根级 `run`、`__service` 或 `__run`。隐藏 `__agent-cli` 只为
workspace 中的 `vela` wrapper 提供 Agent-facing 能力，不是第二个 daemon。

## 2. 单进程拓扑

```text
vela-computer daemon
  ├── native TAT core
  ├── Assignment reconciler
  ├── RuntimeActor × N
  ├── shared loopback Gateway
  └── Goja + embedded LiteChat × Agent session
```

正式构建和发布不得包含 `chatserver-computer`、`chatserver-agent`、`chatserver-im-bridge`、
Node SEA、独立 TAT 可执行文件或每 Agent Manager。

## 3. Agent 启动契约

Computer 通过 HTTPS 长轮询获得完整 Assignment snapshot。每个 Agent assignment 至少绑定：

- `serverID`、`agentID`；
- desired state；
- runtime kind/model；
- reply policy；
- config generation、credential version；
- 当前 launch fence（如存在）。

Registry 最多并发运行五个 Agent，并受全局启动节流控制。影响启动的字段变化会生成新的
RuntimeActor；只更新 revision 的租约变化不重启 Agent。旧 launch 的消息、状态和输出必须被
丢弃。

## 4. IM 与 Runtime

每个 Agent 用自己的短期 UserSig 直连腾讯 IM。腾讯 IM 是消息正文、顺序和漫游历史的
真相源；Chatserver 只保存身份、资源映射、业务状态和消息引用。

Host 为每个 Agent 保留：会话连续游标、不会阻塞 IM 的处理 worker、历史分页恢复和去重
账本。一次 Runtime 处理可以向零个、一个或多个目标发送消息，入站消息与出站消息不建立
强制一对一关系。

Runtime kind 当前为 `codex`、`hermes-acp`、`hermes-gateway`。Runtime 子进程由
RuntimeActor 管理，不拥有 Computer credential、CAM 密钥或其他 Agent 的 UserSig。

## 5. 发布契约

Chatserver 只负责签名、发布和分发外部构建好的 `vela-computer`：

```text
<release>/<target>/
├── vela-computer
├── install.sh
├── manifest.json
└── manifest.sig
```

发布命令必须验证二进制自报版本与 release version 一致；同一版本、target 和对象键不得
覆盖。项目尚未发布，因此不实现旧端侧版本迁移或兼容读取。

## 6. 门禁

- go-client、native TAT 和 Chatserver 全量测试通过；
- `go vet`、关键包 race、凭证扫描和 clean-room 检查通过；
- 发布物只有一个自研端侧可执行文件；
- 首次安装、TAT、Assignment、IM、Runtime、heartbeat 和 LaunchAgent 闭环通过；
- Chatserver 仓库不存在端侧 Host、TAT receiver 或 IM Bridge 源码。
