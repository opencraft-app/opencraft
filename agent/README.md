# raft-computer-go

`raft-computer-go` 是 Chatserver/Vela 的单二进制 Computer Host。当前产品不再实现旧
Raft 云端控制协议，也没有 Raft/Vela 双模式。

## 运行拓扑

```text
Chatserver / 腾讯云 TAT assignment
  → raft-computer-go daemon
      ├── 内嵌 TAT Computer 客户端
      ├── Goja + 内嵌 LiteChat → 腾讯云 IM
      ├── 每 Agent 一个 RuntimeActor → Codex / Hermes
      ├── 一个共享回环 Agent Gateway
      └── 同一二进制 __agent-cli → raft / slock wrapper
```

端侧不持有腾讯云 CAM 密钥或 IM 管理员密钥。Chatserver 签发短期 Runtime Session 和
UserSig；Agent 通过本地 Gateway 使用受限能力，聊天正文与历史以腾讯 IM 为真相源。

## 命令

```text
raft-computer-go daemon run
raft-computer-go status
raft-computer-go doctor
raft-computer-go tui
raft-computer-go version
```

没有模式选择器或根级 `run` 别名；守护进程的唯一入口是
`raft-computer-go daemon run`。`__agent-cli` 是同一二进制提供给 Agent wrapper 的内部
能力，不是第二个 daemon 或兼容模式。

Agent-facing `raft` / `slock` 只暴露 Vela 能力：身份与目录、Inbox、消息、附件、任务和
提醒。命令全集由 `raft --help` 给出，不再存在 profile、integration、migration、
knowledge、mention 或 Channel 管理等旧 Raft 命令。

## 状态与安全边界

- Computer 根目录：`~/.vela`；持久状态位于 `~/.vela/state`。
- Agent 工作区独立位于 `~/.vela/workspaces/<agentID>`，不与可清理运行状态混放。
- 管理员可显式覆盖状态根；程序不再根据当前工作目录创建第二套隐藏状态。
- 不读取或修改 `~/.slock`。
- Agent Gateway 只监听回环地址，每次 launch 使用独立 `sap_` token。
- 腾讯凭据不会写入日志、测试夹具或发布物。
- `internal/cleanroom` 持续执行凭据扫描、恢复源码隔离和架构边界检查。

## 开发验证

```bash
go test ./...
go test -race ./internal/vela/... ./internal/runtimeactor/... ./internal/agentcli/...
go vet ./...
```

macOS ARM64 CGO 构建：

```bash
./scripts/build-vela-macos-arm64.sh --version v0.1.0
```

不可变发布目录：

```bash
./scripts/build-vela-release.sh \
  --version v0.1.0 \
  --agent-binary /absolute/path/raft-computer-go \
  --out-dir /absolute/path/release/darwin-arm64
```

发布与回滚规则见 [Vela 正式发布](docs/vela-release.zh-CN.md)。Runtime 接口与新增 Driver
方法见 [Runtime Driver Guide](docs/runtime-driver-guide.md)。

## Clean-room 证据

旧 Raft 1.0.13 的协议、命令和差分审计只作为冻结证据保存在
[`docs/legacy/raft-1.0.13/`](docs/legacy/raft-1.0.13/)，不参与构建，也不是当前产品契约。
