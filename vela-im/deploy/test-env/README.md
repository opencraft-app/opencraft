# 开发机测试环境

一台机器上跑齐：LightVela 前端（静态导出）+ LightVela API 反向代理 + collaboration（SQLite）+ 开发网关 + Hermes
（每个 Bot 一个 profile，共用一个 multiplex gateway）。当前实例：<https://yuehuali.devcloud.woa.com>（DevCloud，iOA 网关终止 HTTPS）。

```text
浏览器 ──HTTPS──▶ iOA 网关 ──▶ :80 dsh-voice-proxy ──/──▶ 127.0.0.1:13090 vela-web-proxy (nginx)
                                                         ├─ /                  静态前端（frontend/out）
                                                         ├─ /auth|/v1|…        api.lightvela.com（真实 LightVela 登录）
                                                         └─ /v1/collaboration/ 127.0.0.1:18786 开发网关
开发网关：用 api.lightvela.com/auth/profile 校验 LightVela token，去掉客户端身份头，注入内部 Bearer + X-Lightclaw-User-ID
         ──▶ 127.0.0.1:18791 collaboration（/v1/*）
collaboration ──开通 Bot──▶ bot-host.sh：建 profile vb-<hash>、装插件、写 credential/config.json、重启 vela-hermes-gateway
Bot worker ──凭据换会话──▶ 127.0.0.1:18791/v1/runtime/bot/session；浏览器 / worker ──UserSig──▶ 腾讯云 IM
```

生产里这三处分别是 service-gateway、TDSQL 和 CTL（经 TAT 写实例）；collaboration 代码相同，只是启动参数不同
（`--bot-host-ctl-url` 代替 `--bot-host-command`）。开发机没有 CTL，无法校验 Bot 实例归属：`bot-host.py` 默认放行，
设 `VELA_DEV_ALLOWED_ACCOUNTS=usr_a,usr_b` 后只允许这些账号开通。

## 搭建

```bash
# 1. Node 22 与 Hermes（隔离的 HERMES_HOME，不改动机器默认 node）
bash vela-im/deploy/test-env/bootstrap.sh
#    给 $HOME/vela-test/hermes-home 默认 profile 配置模型：config.yaml 的 model/providers 与 .env 中的 key
# 2. 腾讯 IM 密钥（不入库）
install -m 600 /dev/stdin $HOME/vela-test/secrets/im-secret.env <<< 'VELA_IM_SECRET_KEY=...'
# 3. 构建 vela-im（SDK、worker bundle、插件）
cd vela-im && npm ci && npm run build && cd ..
# 4. 构建 OpenCraft 嵌入对话面板（Bot 单聊用；没有它页面会显示“对话加载失败”）
cd opencraft && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci && npm run build:embedded-workbench:release && cd ..
# 5. 构建前端（同源代理模式 + 开启 IM + 同源 OpenCraft）。pnpm 把 file: 依赖拷贝进 node_modules，SDK 改动后先同步一次
cd frontend && pnpm install
SDK=node_modules/.pnpm/@vela+im-client@file+..+vela-im+sdk/node_modules/@vela/im-client
rsync -a --delete ../vela-im/sdk/src/ $SDK/src/ && rsync -a --delete ../vela-im/sdk/dist/ $SDK/dist/
NEXT_PUBLIC_AUTH_API_BASE_URL=local-proxy NEXT_PUBLIC_VELA_IM_API_BASE=/v1/collaboration \
  NEXT_PUBLIC_OPENCRAFT_EMBED_SCRIPT_URL=/__opencraft/embedded-workbench.js NEXT_PUBLIC_REGION=cn npm run build
rsync -a --delete --exclude .vite --exclude '*.map' ../opencraft/apps/workbench-web/dist-embedded-workbench/ out/__opencraft/
rsync -a --delete out/ $HOME/vela-test/web/ && cd ..
# 6. collaboration + 开发网关 + Hermes gateway（systemd）与 nginx（docker）
bash vela-im/deploy/test-env/install.sh
```

`install.sh` 会：

- 在 `$HOME/vela-test/secrets/` 生成一次 `collab-jwt-key`、`collab-identity-key`、`collab-gateway-token`（0600，之后保留；
  身份派生密钥决定所有 IM UserID，不能换），并从 `im-secret.env` 生成 `im-secret-key`；
- 编译 `collaboration/cmd/chatserver` 到 `$HOME/vela-test/bin/`，数据库在 `$HOME/vela-test/collab-data/`；
- 把旧身份服务留下的 `vela-*` profile 移到 `$HOME/vela-test/retired-profiles/`，停用 `vela-im.service`；
- 安装并重启 `vela-collaboration`、`vela-collab-gateway`、`vela-hermes-gateway`，重建 `vela-web-proxy`。

## 测试

1. 打开站点并用真实 LightVela 账号登录，进入 `/agents/chat`。
2. 在 IM 区新建群或把单聊升级为群，选择自己的 Bot：首次选择时自动开通（本机出现 `vb-…` profile，gateway 约几秒后重启，
   该 Bot 的 worker 上线）。
3. 在群里 @ Bot，确认按回复模式触发；在群设置里切换回复模式、邀请 / 移除成员、解散。
4. 在 Bot 的终端里 `vela_im whoami`、`vela_im send --text …` 等（或在对话里让它用 `vela_im`）。

不依赖登录的后台冒烟测试（真实腾讯 IM，独立端口与数据，不影响上面的服务）：

```bash
bash vela-im/deploy/test-env/smoke.sh
```

覆盖：网关拒绝无登录请求、人类换 UserSig、Bot 开通与重复开通、凭据文件权限与插件启用、凭据换会话、伪造凭据被拒、worker 上线与
`vela_im whoami`、平台建群 / 改规则 / Bot 读群 / Bot 发群消息、解散、删除 Bot 后旧凭据失效且腾讯账号被删除、平台账号清单与腾讯核对一致。状态保存在 `$HOME/vela-test/smoke/`，
重复运行复用同一组腾讯账号。

## 管理后台（IM 群聊运营）

```bash
bash vela-im/deploy/test-env/install-admin.sh   # 构建 gateway-dashboard，systemd 常驻，nginx 挂到 /admin/gateway
```

打开 <https://yuehuali.devcloud.woa.com/admin/gateway/im>，用 `$HOME/vela-test/secrets/dashboard-admin-token` 的内容登录。
开发机没有 AI Gateway：登录由 `dev-admin-auth.mjs` 校验这个 Token，只有「IM 群聊」页可用，其他页面会报错。
后台调用 collaboration 的 `/v1/admin/im/**`，Token 是 `collab-admin-token`（`install.sh` 生成并传给 `--admin-token-file`）。

## 运维

```bash
systemctl status vela-collaboration vela-collab-gateway vela-hermes-gateway
journalctl -u vela-collaboration -f
journalctl -u vela-collab-gateway -f
tail -f $HOME/vela-test/hermes-home/logs/gateway.log          # 各 Bot 的 vela_im 适配器上线情况
tail -f $HOME/vela-test/hermes-home/profiles/vb-*/plugin-data/vela-im/worker.log
docker logs vela-web-proxy
# 封禁 / 解封某个 IM 身份（SQLite 需先停服务）
sudo systemctl stop vela-collaboration
CHATSERVER_DATABASE_PATH=$HOME/vela-test/collab-data/collaboration.sqlite $HOME/vela-test/bin/chatserver im restrict \
  --im-user-id a_xxx --im-sdk-app-id 1600137234 --im-admin-user-id administrator \
  --im-secret-key-file $HOME/vela-test/secrets/im-secret-key        # 加 --release 解封
sudo systemctl start vela-collaboration
```

平台创建过的全部腾讯账号（腾讯控制台看不到）与腾讯侧核对：

```bash
CHATSERVER_DATABASE_PATH=$HOME/vela-test/collab-data/collaboration.sqlite $HOME/vela-test/bin/chatserver im accounts --list \
  --check --im-sdk-app-id 1600137234 --im-admin-user-id administrator --im-secret-key-file $HOME/vela-test/secrets/im-secret-key
```

腾讯 IM 回调（成员对账、发消息前封禁、建群拦截）需要公网可达的回调地址，开发机收不到；平台自己发起的操作不依赖回调。
试用版 IM 应用最多 100 个账号，超出时导入失败（腾讯错误 70398）。每个账号最多开通 20 个 Bot（`--max-im-bots-per-account`），
删除 Bot 会删除其腾讯账号。不要删除 `collab-data/` 后继续用同一个 SDKAppID，否则旧账号会变成无人记录的孤儿。
