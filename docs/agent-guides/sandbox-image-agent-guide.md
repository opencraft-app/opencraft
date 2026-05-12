# Sandbox Image Agent Guide

本文件约束 `images/` 目录下的 sandbox 镜像构建工作。涉及基础镜像、应用镜像、TAT 运行时、OpenClaw/gateway 启动问题时，Agent 应先阅读本文件。

相关文档：

- 镜像实现细节： [images/README.md](../../images/README.md)
- sandbox 总入口： [docs/agent-guides/sandbox-agent-guide.md](sandbox-agent-guide.md)
- rollout 与部署： [docs/deploy-guides/sandbox-deploy-guide.md](../deploy-guides/sandbox-deploy-guide.md)
- `envd` 独立 follow-up： [docs/developer-guide/sandbox-envd-side-effect-followup.md](../developer-guide/sandbox-envd-side-effect-followup.md)

## 1. 当前方案

当前“最新 base/app 镜像 ID”的权威来源统一收敛在镜像台账顶部自动维护区：

- [docs/developer-guide/sandbox-image-version-inventory.md](../developer-guide/sandbox-image-version-inventory.md)

- 发行版固定为 `Ubuntu 24.04 LTS x86_64`
- 公网基础镜像固定为 `img-mmytdhbn`
- 当前已验证可用的基础镜像（`2026-03-25`）为 `img-id352nof`
- 构建模型固定为双层：
  - `base`: OS、envd、Node、Python、Playwright、系统依赖
  - `app`: OpenClaw、ClawHub、qqbot、weixin、gateway、OpenClaw 配置
- 当前默认应用版本固定为：
  - `openclaw 2026.3.24`
  - `@tencent-connect/openclaw-qqbot@1.6.6`
  - `@tencent-weixin/openclaw-weixin@2.1.1`
- 额外支持实验性运行时分支：
  - `python3 images/build-image.py --runtime hermes ...`
  - 默认运行用户为 `agentuser`
  - 默认 Hermes 产物来自内部 COS pin 版本：`hermes-agent-v20260506` / `0.12.0`
  - 镜像内安装 `acli` 并跑 `acli doctor`；CTL 初始化优先走 `acli model set`，旧镜像回退动态注入 `harness`
  - 默认验证套件为 `runtime-hermes`

## 2. 关键不变量

- 不再维护 TencentOS / OpenCloudOS / `nvm` / `source ~/.bashrc` 旧路径
- `node` / `npm` / `pnpm` / `openclaw` 必须能在最小 PATH 下直接执行
- `openclaw-weixin-login-session` 必须作为镜像内正式协议入口安装到最小 PATH
- gateway 必须依赖镜像本身启动成功，不能把稳定性建立在 TAT/SSH 渠道补环境上
- `--runtime hermes` 是并行实验路径，不应默认替代现有 OpenClaw 主链镜像
- `openclaw` wrapper 可以做命令级环境补齐，但应尽量收敛到单一实现；当前统一对 `openclaw` CLI 补默认 `NODE_OPTIONS`，不再为单个子命令继续加特判
- 默认策略优先级应是：更高的基础实例规格 + 单一 `openclaw` CLI heap policy + 构镜时 pin 插件版本；不推荐继续叠加越来越多的命令级临时兜底
- OpenClaw 运行态统一绑定 `LIGHTCLAW_RUNTIME_USER`（默认 `lightclaw`）：
  - 配置目录：`/home/<runtime-user>/.openclaw`
  - gateway user unit：`/home/<runtime-user>/.config/systemd/user/openclaw-gateway.service`
- 镜像版本元数据必须在正式构镜前写盘：
  - `/etc/lightclaw/image-version`
  - `/etc/lightclaw/image-build.json`

## 3. 推荐工作流

- 首次或底座变更时，先产 `base`：
  - `python3 images/build-image.py --build-base`
- 日常改 OpenClaw / 插件时，只跑 `app-only`：
  - `python3 images/build-image.py --base-image-id img-id352nof --with-verify`
  - 如需附带 `envd` 独立回归，再显式加：`--verify-suites envd,runtime`
- 如需实验 Hermes 运行时：
  - `python3 images/build-image.py --runtime hermes --base-image-id img-id352nof --with-verify`
  - 可用 `--hermes-version hermes-agent-v20260506` 临时覆盖 Hermes COS 版本
  - 默认不会跑 OpenClaw 的 `runtime` / `weixin-login` 校验
- 如果目标是验证 `weixin` 新版本，优先重新构镜并在 fresh sandbox 上验收；不要默认依赖“进实例临时 `openclaw plugins install/update`”这条高波动路径
- 只验证到实例、不制镜时：
  - `python3 images/build-image.py --base-image-id img-id352nof --with-verify --skip-create-image --skip-sync-image`
- 除非在排查底座问题，不要把“全量从公网镜像开始”作为日常验证路径

## 4. 当前验收标准

- SSH 非交互 shell 下：
  - `openclaw --version` 成功
  - `env -i HOME=/home/lightclaw USER=lightclaw PATH=/usr/bin:/bin openclaw --version` 成功
  - `env -i HOME=/home/lightclaw USER=lightclaw PATH=/usr/bin:/bin openclaw gateway restart` 成功
  - `env -i HOME=/home/lightclaw USER=lightclaw PATH=/usr/bin:/bin openclaw-weixin-login-session --help` 成功
- gateway：
  - `systemctl --user is-enabled openclaw-gateway` 返回 `enabled`
  - `systemctl --user is-active openclaw-gateway` 返回 `active`
  - `127.0.0.1:18789` 已监听
- 插件：
  - `qqbot` 已安装
  - `weixin` 已安装
- OpenClaw CLI：
  - 所有 `openclaw` 命令默认继承镜像 wrapper 注入的 `NODE_OPTIONS=--max-old-space-size=1536`，除非调用方已显式覆盖
- OOM 排障：
  - `openclaw channels login`
  - `openclaw onboard`
  - `openclaw plugins install/update`
  这些路径都曾在小规格实例上实测触发过 heap OOM，排障时不要只盯微信登录
- TAT：
  - 真实 TAT 调用链已验证 `openclaw --version`、`openclaw gateway restart`、gateway 状态和 `18789` 端口可用

## 5. 微信登录协议专项

- 镜像内正式协议命令是 `openclaw-weixin-login-session`，不是 `images/helpers/config-weixin-channel.sh`
- 状态目录固定在 `/tmp/lightclaw-weixin-login/<session_id>/`
- 首轮完成标准是稳定拿到 `waiting_qr`，且 `qr_ascii` / `qr_url` 至少一个非空
- `start/status/cancel` 默认输出单行 JSON，供后续 CTL 接入消费
- `test-runtime.sh` 只做轻量存在性和最小 PATH 检查
- 真正的二维码专项验收使用 `bash images/tests/test-weixin-login-protocol.sh ubuntu@<host>`
- 若改动了 weixin 插件版本、二维码解析逻辑、协议状态机或运行时安装路径，应额外跑 `python3 images/build-image.py --with-verify --verify-suites runtime,weixin-login ...`

## 6. 已知实现细节

- Ubuntu 公网镜像 reset 后，首登用户通常是 `ubuntu`
- 构建脚本会在首次登录阶段补齐运行态用户（`LIGHTCLAW_RUNTIME_USER`）的 `~/.ssh/authorized_keys`
- 构建与验证入口统一使用 `ubuntu@host:22`，不再依赖 root 直连
- reset 后即使已经通过 SSH ready 检查，首个 `ssh mkdir/scp/remote build` 仍可能偶发瞬时断连；当前 [deploy-build.sh](../../images/deploy-build.sh) 已对 SSH ready、建远端目录、上传文件、远端执行统一加重试
- `openclaw 2026.3.24` 的 `gateway install` 仍需按当前镜像流程做制镜前 unit 非空预检和刷盘
- 当前 [build.sh](../../images/build.sh) 已兼容这个“半成功”状态：检测到 unit 已存在时会继续 `daemon-reload + enable + restart`
- `envd` 当前仍有一个独立问题待排查：`process.Process/Start` 在测试中返回 `200` 且日志显示 `exit status 0`，但预期 side effect 文件未在宿主机路径出现；详见 [docs/developer-guide/sandbox-envd-side-effect-followup.md](../developer-guide/sandbox-envd-side-effect-followup.md)
- 因为上述问题未闭环，`envd` 当前不再作为默认制镜门禁；默认 `--with-verify` 仅跑 `runtime`
- `2026-03-28` 的实例内实测表明：小规格 fresh sandbox 上连 `openclaw plugins install/update @tencent-weixin/openclaw-weixin@2.1.1` 本身都可能因为 heap 不够而失败；因此“进实例临时升级插件”不应作为默认验证路径

## 7. 文档更新规则

- 如果修改了镜像分层边界、默认版本、运行用户、gateway 运行形态，必须同步更新本文件
- 如果修改了 rollout 流程或推荐命令，必须同步更新 deploy guide
- 如果产出了新的“当前推荐 base 镜像”，应带日期更新本文件和 [images/README.md](../../images/README.md)
