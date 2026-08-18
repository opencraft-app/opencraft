# 独立 k3s Computer 发布运行手册

本手册发布双平台 `vela-computer` Release Set，并把一个指定的测试 Computer 升级到该版本。它不发布
Web 或 Backend image，也不宣称独立 Computer Update Channel 已经上线。

## 正式入口

```bash
agent/deploy/k3s/release.sh deploy \
  --version vX.Y.Z \
  --builder root@AUTHORIZED_BUILDER \
  --builder-port 36000 \
  --builder-identity /absolute/builder-key \
  --target root@21.91.75.85 \
  --target-port 36000 \
  --target-identity /absolute/k3s-key \
  --computer root@TEST_COMPUTER \
  --computer-port 36000 \
  --computer-identity /absolute/computer-key \
  --expected-agent-id AGENT_UUID \
  --update-channel-url http://21.91.75.85 \
  --allow-insecure-update-http \
  --release-key-id RELEASE_KEY_ID \
  --release-private-key /secure/offline/release.private \
  --release-public-key /secure/offline/release.public \
  --channel-key-id CHANNEL_KEY_ID \
  --channel-public-key /secure/channel.public \
  --evidence /secure/absolute/evidence/computer-vX.Y.Z
```

所有 identity、key 和 evidence 参数都必须是绝对路径。Release 私钥必须是权限 `0600` 的普通文件；
脚本不会把私钥、COS 凭据、短期 URL 或 Computer credential 写入证据。

## 发布模型

```text
clean pushed commit
→ TUI reproducibility + Agent/Computer gates
→ Mac native darwin-arm64 build
→ authorized Buildx linux-amd64 build
→ dual-target Release Set build + independent verification
→ COS create-only publish
→ versioned immutable k3s catalog
→ selected test Computer atomic swap
→ actual version + systemd + expected Agent readiness
```

Mac 不运行 Docker。Linux builder、k3s target 和测试 Computer 是三个显式 SSH 信任边界，全部强制
`BatchMode=yes`、`IdentitiesOnly=yes` 和独立 identity。

脚本会在第 1 步、任何 COS 或 catalog mutation 前验证三台主机的运行依赖。k3s target 缺少 `jq` 时，脚本会
尝试使用该 root 主机已有的 `dnf`、`apt-get` 或 `apk` 安装；没有受支持包管理器则预检失败，不会开始发布。
不要手工绕过该预检或在已开始 catalog 切换后补依赖。

## Catalog 与 Computer 事务

脚本先保存 Backend 当前 catalog，再创建唯一版本名的 immutable ConfigMap，回读并切换 Backend。
随后才把已验签的 Linux 程序传给测试 Computer。

Computer 在本机保存旧程序和 `install.journal.json`，使用同文件系统原子替换，重启 systemd，并要求：

- 二进制自报目标版本；
- daemon 在线；
- 每个 `--expected-agent-id` 都为 `running/ready`。

Catalog 切换后任何步骤失败，脚本先恢复 Computer，再恢复原 catalog。新 COS 对象和新版本 ConfigMap
保持 create-only，作为失败诊断证据，不覆盖或删除。

## Update Channel 边界

二进制仍携带发布时固定的 Channel URL、Channel 公钥和 Release 公钥。HTTP URL 只允许在命令显式提供
`--allow-insecure-update-http` 时构建。

当前脚本的测试 Computer rollout 不依赖 Channel 服务。独立 `chatserver computer-update serve`、持久化
Channel store、专用在线私钥、匿名读取路由和 operator promotion 尚需单独部署；在完成之前不能把本脚本
描述成全量 Computer 后台自动升级平台。

Release key 使用仓库外的长期离线 key。普通发布复用 active key；只有明确执行信任迁移时才生成/切换 key。
旧 Computer 不会因为 catalog 指向新 key 就自动信任它，因此 key 轮换不能与普通版本发布混为一谈。

## 发布证据

成功 evidence 至少包含：

- `release-evidence.json`；
- 完整双 target Release Set 与验签产物；
- Linux Buildx metadata；
- TUI bundle manifest/hash；
- 切换后的 Backend Deployment；
- 测试 Computer 的安全状态投影。
