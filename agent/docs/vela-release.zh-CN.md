# Vela 正式发布

## 唯一运行模式

`raft-computer-go daemon run` 是 Chatserver Platform v1 的唯一 Computer daemon 入口。
项目尚未发布，不提供 `--mode`、根级 `run` 或旧服务角色兼容层。

```text
Chatserver / 腾讯云 TAT
  → raft-computer-go daemon run
  → 内嵌 LiteChat / 腾讯云 IM
  → RuntimeActor / Codex 或 Hermes
```

Chatserver 定义 Agent、签发短期 Runtime Session/UserSig 并编排 TAT。Agent Host 不持有
腾讯云 CAM 密钥或 IM 管理员密钥。

## 发布目录

每个平台目录保持平铺且不可变：

```text
<version>/<platform-arch>/
├── raft-computer-go
├── SHA256SUMS
└── VERSION
```

当前正式验收目标为 `darwin-arm64`。Linux 产物必须完成对应平台 Canary 后才能标记正式。

## 构建与验收

```bash
./scripts/build-vela-macos-arm64.sh \
  --version v0.1.0 \
  --output /absolute/path/raft-computer-go

./scripts/build-vela-release.sh \
  --version v0.1.0 \
  --agent-binary /absolute/path/raft-computer-go \
  --out-dir /absolute/path/release/darwin-arm64

go test ./...
go test -race ./internal/vela/... ./internal/runtimeactor/... ./internal/agentcli/...
go vet ./...

/absolute/path/release/darwin-arm64/raft-computer-go version
cd /absolute/path/release/darwin-arm64 && shasum -a 256 -c SHA256SUMS
```

构建脚本拒绝 `latest`、符号链接输入和已存在的输出目录，避免覆盖已经分发的版本。

## 回滚

回滚只允许将后台 artifact version 指向上一不可变版本并重新 deploy。禁止覆盖同一版本
目录。Runtime Credential 独立轮换，不随二进制回滚，也不复制进发布物。
