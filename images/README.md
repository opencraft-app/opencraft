# LightClaw Sandbox Image Build

`images/` 目录现在固定为 Ubuntu 24.04 LTS 的双层镜像构建方案，不再维护 TencentOS / `nvm` / user-level systemd 旧路径。

## Layout

```text
images/
├── build-manifest.json        # pinned 基础镜像 / Node / OpenClaw / Playwright 版本
├── build-image.py             # 主入口：重装、构建、验证、制镜、跨区复制
├── deploy-build.sh            # 上传 build.sh / manifest / envd 到远端并执行
├── build.sh                   # 远端实际构建脚本（Ubuntu 24.04 only）
├── helpers/
├── tests/
│   ├── test-envd-agent.sh
│   ├── test-runtime.sh
│   ├── test-weixin-login-protocol.sh
│   └── test-onboard.sh
├── runtime/
│   └── openclaw-weixin-login-session.sh
└── bin/
```

## Current Contract

当前“最新 base/app 镜像 ID”的权威来源统一收敛在：

- [docs/developer-guide/sandbox-image-version-inventory.md](docs/developer-guide/sandbox-image-version-inventory.md)

- 基础发行版：`Ubuntu 24.04 LTS x86_64`
- 基础公网镜像 ID：`img-mmytdhbn`
- Node：系统级固定安装，不使用 `nvm`
- OpenClaw：系统级安装到 `/usr/local`
- 当前默认应用版本：`openclaw 2026.3.24` + `@tencent-connect/openclaw-qqbot@1.6.6` + `@tencent-weixin/openclaw-weixin@2.1.1`
- Gateway：OpenClaw 官方 `openclaw-gateway.service` user service
- SSH：保持发行版默认端口 `22`

镜像版本元数据会在正式构镜前写入：

- 远端：
  - `/etc/lightclaw/image-version`
  - `/etc/lightclaw/image-build.json`
- 本地：
  - `images/out/latest-image-version.txt`
  - `images/out/latest-image-build.json`

## Build Model

### Base Image

基础层负责：

- `envd` system service
- 系统依赖与 `apt` 基础包
- 固定 Node / npm / pnpm
- Python venv 与 Playwright 浏览器依赖
- `LIGHTCLAW_RUNTIME_USER`（默认 `lightclaw`）SSH key 登录准备

构建命令：

```bash
python3 images/build-image.py --build-base
```

当前稳定 `base` 镜像见镜像台账；截至 `2026-03-25` 为：

- `img-id352nof`

### App Image

应用层负责：

- `openclaw`
- `clawhub`
- 默认插件为 `openclaw-qqbot` + `openclaw-weixin`
- 如需覆盖默认插件集合，可显式传 `--only-plugins`
- 微信登录结构化协议命令 `openclaw-weixin-login-session`
- OpenClaw 官方 gateway user service
- OpenClaw 配置与 AGENTS.md 定制

构建命令：

```bash
python3 images/build-image.py --base-image-id img-id352nof
python3 images/build-image.py --base-image-id img-id352nof --with-verify
python3 images/build-image.py --base-image-id img-id352nof --with-verify --skip-create-image --skip-sync-image
```

如需改走 Hermes 运行时，而不是 OpenClaw：

```bash
python3 images/build-image.py --runtime hermes --base-image-id img-id352nof
python3 images/build-image.py --runtime hermes --base-image-id img-id352nof --with-verify
python3 images/build-image.py --runtime hermes --base-image-id img-id352nof --with-verify --skip-create-image --skip-sync-image
```

当前 Hermes 路径：

- 默认运行用户：`agentuser`
- 默认从 `runtime_hermes.cos_base` 的 `latest.json` 解析 Hermes tarball 和源版本；可用 `--hermes-version` 临时 pin 到指定 COS 目录
- 解压到 `~/.hermes/hermes-agent`，伪造成本地 git repo 后复用官方 `install.sh --skip-setup --branch main`
- 安装 `@qwen-code/qwen-code`
- 为 `agentuser` 固化 PyPI mirror：`mirrors.tencent.com` 为 primary，`mirrors.cloud.tencent.com` 为 extra，并预装 `lark-oapi==1.5.3`、`qrcode==7.4.2`
- 预装 Hermes platform plugin `lightclawbot` 到 `/home/agentuser/.hermes/plugins/lightclawbot`，并在 `/home/agentuser/.hermes/config.yaml` 启用；镜像不写入 `LIGHTCLAW_API_KEY_<UIN>`，实例运行时再注入
- 为 `agentuser` 的 `~/.hermes/hermes-agent/scripts/whatsapp-bridge` 预装 `@whiskeysockets/baileys@7.0.0-rc.9`、`qrcode-terminal`、`express`、`pino`
- 安装 `skillhub --cli-only`
- 裁剪 Hermes bundle skills，仅保留核心开发、调试、QA、文档和轻量研究类 skill
- 安装 `acli` 并以 `acli doctor` 作为 gate
- 动态解析 Lighthouse 最新非南京 Hermes backend blueprint，并以 `agentuser` 执行 `acli backend upgrade-start --blueprint-id <id> --wait=true --force=true`
- 默认验证套件：`runtime-hermes`
- 不支持 OpenClaw 的插件 / skill 安装参数

CI 入口：

- `master` 上 `images/**` 变更会触发 `.ci/hermes-image.yml`；如果只改 `.ci/**`，需要手动触发，或同时更新 `images/hermes-image-trigger`
- CI 使用 `python3 images/build-image.py --runtime hermes --base-image-id img-id352nof --target-regions ap-beijing,ap-shanghai,ap-singapore --with-verify`
- CI 会在验证日志中打印 Hermes 命令路径、`hermes --version` 输出、解析版本和 `acli` identity runtime 字段
- CI 会验证 `agentuser` 下 WhatsApp bridge 的 Node 依赖可被 `require.resolve` 找到
- CI 会验证 `agentuser` 的 Hermes venv 可以 import `lark_oapi` 和 `qrcode`
- Hermes CI 镜像会并发同步到北京、上海和新加坡
- Hermes CI 在人工确认后会从仓库内修补脚本临时创建 TAT Command 修复存量 VM，不要求手工传 `HERMES_TAT_COMMAND_ID`
- TAT Command 创建脚本会动态解析最新非南京 Hermes backend blueprint，并把 ID 注入到下发脚本环境，目标 VM 不需要携带仓库文件
- `images/hermes-image-trigger` 是专用触发文件；当只改 `.ci/**` 但需要触发 `.ci/hermes-image.yml` 时，更新这个文件并随 MR 合入
- 腾讯云凭据从构建机本地 `/etc/lightclaw-ci/tencentcloud_secret_id` 和 `/etc/lightclaw-ci/tencentcloud_secret_key` 读取
- CI 会自动安装并缓存 `tccli`，不要求构建机预装腾讯云 CLI
- CI 会自动安装并缓存 Go，用于上传前本地编译 `images/bin/envd`

存量 Hermes 机器修复：

- `images/helpers/config-hermes-python-mirrors.sh` 可通过 TAT/debug exec 下发到存量机器，修复 `agentuser` 的 pip/uv mirror 配置、`~/.config/systemd/user` 权限，并执行同一 backend blueprint 升级基线
- TAT 建议用 root/default 身份执行；脚本内部通过 `LIGHTCLAW_RUNTIME_USER`（默认 `agentuser`）定位目标用户 home、修正文件属主，并通过 `sudo -u agentuser -H bash -lc` 执行 `acli backend upgrade-start --blueprint-id <id> --wait=true --force=true`
- `acli backend upgrade-start` 命令本身不加 `sudo`，必须以 `agentuser` 身份运行

### Hermes Backend Blueprint Resolution

Hermes backend blueprint 默认不维护静态 Git 基线。构建和存量 VM 修复都会调用：

```text
images/helpers/resolve-hermes-backend-blueprint-id.py
```

解析规则：

- 查询 `ap-beijing` 的 Lighthouse blueprint 列表
- 只选择 `BlueprintName` / `DisplayTitle` / `DisplayName` 为 `hermes_agent` / `Hermes Agent` 的 `NORMAL` blueprint
- 排除名称、标题、描述、系统名或平台里包含 `南京` / `nanjing` 的 blueprint
- 按 `CreatedTime` 选择最新的一条
- 如果动态解析失败，构建和 TAT 命令生成直接失败，不回退到静态文件

当前基线命令为：

```bash
acli backend upgrade-start --blueprint-id "$(python3 images/helpers/resolve-hermes-backend-blueprint-id.py)" --wait=true --force=true
```

执行身份约束：

- CVM 镜像构建：`images/build-image.py` / `images/deploy-build.sh` 先解析最新非南京 blueprint，再把 `HERMES_BACKEND_BLUEPRINT_ID` 注入远端构建；`images/build.sh` 会用同一个 resolver 作为直接执行时的解析入口
- 存量 VM 修复：`.ci/runtime/commands/create_hermes_tat_command.sh` 解析最新非南京 blueprint，并把 `HERMES_BACKEND_BLUEPRINT_ID` 注入到 TAT command 内容；目标 VM 上的修补脚本再以 `agentuser` 执行该命令
- 如需一次性人工覆盖，可显式设置 `HERMES_BACKEND_BLUEPRINT_ID=lhbp-...`
- 不要写成 `sudo acli backend upgrade-start ...`；如果 TAT 以 root 执行，只允许用 sudo 切换到 `agentuser`

### Full Build

从 Ubuntu 公网镜像直接完整构建：

```bash
python3 images/build-image.py
```

## Manifest

版本收敛在 [build-manifest.json](images/build-manifest.json)。

默认行为约束：

- `build-manifest.json` 是默认版本号与构建源的唯一权威来源
- `images/build-image.py` / `images/deploy-build.sh` / `images/build.sh` 的 CLI 参数只用于单次构建 override
- 如果 manifest 缺失必填字段，构建脚本会直接失败，而不是悄悄回退到另一套 hardcode

当前清单定义：

- 基础镜像 ID
- Node / pnpm / OpenClaw / Playwright 版本
- Python venv 路径
- Playwright 浏览器缓存路径
- npm registry 与可选制品源

首版先直接 hardcode 到：

- `openclaw 2026.3.24`
- `@tencent-connect/openclaw-qqbot@1.6.6`
- `@tencent-weixin/openclaw-weixin@2.1.1`

升级策略仍是修改 manifest 后重新出镜像，不依赖实例内长期 `openclaw upgrade`。

查询当前 pinned 与远端最新版本：

```bash
python3 images/build-image.py versions
python3 images/build-image.py versions --format json
```

临时覆盖单次构建版本：

```bash
python3 images/build-image.py --openclaw-version 2026.3.24 --qqbot-version 1.6.6 --weixin-version 2.1.1
```

切到 Hermes 分支运行时：

```bash
python3 images/build-image.py --runtime hermes
python3 images/build-image.py --runtime hermes --hermes-version hermes-agent-v20260520
```

## Manual Build

手动远端构建入口：

```bash
bash images/deploy-build.sh ubuntu@<host>
bash images/deploy-build.sh ubuntu@<host> --base-only
bash images/deploy-build.sh ubuntu@<host> --app-only --only-plugins qqbot,weixin
```

`deploy-build.sh` 会上传：

- `build.sh`
- `build-manifest.json`
- `helpers/resolve-hermes-backend-blueprint-id.py`
- `bin/envd`
- `runtime/openclaw-weixin-login-session.sh`

脚本默认通过 `ubuntu@host` 登录，并通过 `sudo` 执行远端构建；构建过程中会补齐运行态用户（`LIGHTCLAW_RUNTIME_USER`）的 `authorized_keys`，不再依赖 root 远程登录。

Gateway 仍走 OpenClaw 官方 user service 安装，但镜像会额外放一个很薄的 `openclaw` wrapper：

- 补 `XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS`，保证非交互 shell 下的 `openclaw gateway restart` 正常工作
- 对所有 `openclaw` CLI 调用按实际宿主机或 cgroup 内存动态计算 `NODE_OPTIONS=--max-old-space-size`
  默认取检测到内存的 `50%`
  可通过 `OPENCLAW_MAX_OLD_SPACE_SIZE_MB` 显式指定
  默认 cap 为 `8192MB`
  也可用 `OPENCLAW_MAX_OLD_SPACE_SIZE_PERCENT` / `OPENCLAW_MAX_OLD_SPACE_SIZE_MIN_MB` / `OPENCLAW_MAX_OLD_SPACE_SIZE_CAP_MB` 调整自动策略
- 如果调用方已经显式传了 `NODE_OPTIONS`，wrapper 不覆盖用户值

## Weixin Login Protocol

镜像内正式协议入口是 `openclaw-weixin-login-session`，安装到：

- `/usr/local/bin/openclaw-weixin-login-session`
- `/usr/bin/openclaw-weixin-login-session`

它不是 `images/helpers/config-weixin-channel.sh` 的替代壳脚本，而是给上层服务消费的结构化协议命令。状态目录固定为：

- `/tmp/lightclaw-weixin-login/<session_id>/state.json`
- `/tmp/lightclaw-weixin-login/<session_id>/output.log`
- `/tmp/lightclaw-weixin-login/<session_id>/worker.pid`

子命令：

- `start`: 后台启动真实 `openclaw channels login --channel openclaw-weixin` worker，立即返回 `status=starting`
- `status`: 仅读取 `state.json`，不重新触发登录命令
- `cancel`: 终止 worker，并把会话收敛到 `cancelled`
- `gc`: 清理已过期且非 active 的会话目录

手动验证示例：

```bash
openclaw-weixin-login-session start --session-id manual_1 --timeout-seconds 300
openclaw-weixin-login-session status --session-id manual_1
openclaw-weixin-login-session cancel --session-id manual_1
```

协议只要求首轮稳定拿到二维码事实源。`qr_ascii` 是首要展示字段，`qr_url` 是辅助字段；任一非空即可视为 `waiting_qr`。

## Verification

运行时门禁重点检查：

- `openclaw --version` 在非交互 shell 下可用
- `env -i HOME=/home/lightclaw USER=lightclaw PATH=/usr/bin:/bin openclaw --version` 可用
- `env -i HOME=/home/lightclaw USER=lightclaw PATH=/usr/bin:/bin openclaw gateway restart` 可用
- `env -i HOME=/home/lightclaw USER=lightclaw PATH=/usr/bin:/bin openclaw-weixin-login-session --help` 可用
- `systemctl --user is-enabled openclaw-gateway`
- `systemctl --user is-active openclaw-gateway`
- 端口 `18789` 已监听

手动执行：

```bash
bash images/tests/test-runtime.sh ubuntu@<host>
```

微信登录专项协议验证不默认作为 blocker，但已接入标准 verify suite：

```bash
bash images/tests/test-weixin-login-protocol.sh ubuntu@<host>
python3 images/build-image.py --base-image-id img-id352nof --with-verify --verify-suites runtime,weixin-login --skip-create-image --skip-sync-image
```

`weixin-login` suite 验证的是“成功获取微信登录二维码”，不是完整扫码成功链路。

`envd` 验证脚本仍保留，但当前不再作为默认制镜 blocker；如需单独排查再显式执行：

```bash
bash images/tests/test-envd-agent.sh ubuntu@<host>
```

## CTL Follow-up

后续 CTL 接入应直接调用：

- `openclaw-weixin-login-session start`
- `openclaw-weixin-login-session status`
- `openclaw-weixin-login-session cancel`

CTL 不应再把 PTY 原始输出当成二维码唯一事实源；输出解析与状态收敛职责应留在镜像内部协议脚本。
