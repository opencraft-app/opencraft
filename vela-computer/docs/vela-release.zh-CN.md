# Vela 正式发布

## mono2候选交付（不等于正式下发）

`.ci/vela-computer.yml`只对`vela-computer/**`的master变更构建原生Linux AMD64候选，
以源码SHA命名并归档到流水线制品库，不修改实例、后台artifact version或更新通道。
归档插件可用性、真实Linux构建与Runtime/IM Canary须由实际流水线分别验证。

本地可为当前宿主生成未资格化候选：

```bash
./scripts/build-vela-candidate.sh \
  --source-sha FULL_CHECKED_OUT_SHA --out-dir /new/absolute/candidate/path
```

它检查完整SHA与checkout一致，拒绝已有目录；仅包含`vela-computer`、`VERSION`、
`CANDIDATE.json`和`SHA256SUMS`。元数据标明`kind=candidate`、源码dirty状态与
`deploymentQualified=false`；三个内容文件全部校验，运行version时使用隔离临时状态根。
构建没有CGO/原生TAT桥、签名材料或内置更新通道，不能拿此候选声明正式机器纳管可用。

下述旧正式/TAT流程是迁移保留基线，不作为LightVela托管聊天客户端的本轮下发入口。

## 唯一运行模式

`vela-computer daemon run` 是 Chatserver Platform v1 的唯一 Computer daemon 入口。
项目尚未发布，不提供 `--mode`、根级 `run` 或旧服务角色兼容层。

```text
Chatserver / 腾讯云 TAT
  → vela-computer daemon run
  → 内嵌 LiteChat / 腾讯云 IM
  → RuntimeActor / Codex 或 Hermes
```

Chatserver 定义 Agent、签发短期 Runtime Session/UserSig 并编排 TAT。Agent Host 不持有
腾讯云 CAM 密钥或 IM 管理员密钥。

## 发布目录

每个平台目录保持平铺且不可变：

```text
<version>/<platform-arch>/
├── vela-computer
├── SHA256SUMS
└── VERSION
```

当前正式验收目标为 `darwin-arm64`。Linux 产物必须完成对应平台 Canary 后才能标记正式。

## 构建与验收

```bash
./scripts/build-vela-macos-arm64.sh \
  --version v0.1.0 \
  --output /absolute/path/vela-computer

./scripts/build-vela-release.sh \
  --version v0.1.0 \
  --agent-binary /absolute/path/vela-computer \
  --out-dir /absolute/path/release/darwin-arm64

go test ./...
go test -race ./internal/vela/... ./internal/runtimeactor/... ./internal/agentcli/...
go vet ./...

/absolute/path/release/darwin-arm64/vela-computer version
cd /absolute/path/release/darwin-arm64 && shasum -a 256 -c SHA256SUMS
```

构建脚本拒绝 `latest`、符号链接输入和已存在的输出目录，避免覆盖已经分发的版本。

## 回滚

回滚只允许将后台 artifact version 指向上一不可变版本并重新 deploy。禁止覆盖同一版本
目录。Runtime Credential 独立轮换，不随二进制回滚，也不复制进发布物。
