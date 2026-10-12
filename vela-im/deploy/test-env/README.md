# 单机测试环境

一台机器上跑齐：LightVela 前端（静态导出）+ LightVela API 反向代理 + Vela IM 身份服务 + Hermes（每个 Agent 一个
profile，共用一个 multiplex gateway）。当前实例：<https://yuehuali.devcloud.woa.com>（DevCloud，iOA 网关终止 HTTPS）。

```text
浏览器 ──HTTPS──▶ iOA 网关 ──▶ :80 dsh-voice-proxy ──/──▶ 127.0.0.1:13090 vela-web-proxy (nginx)
                                         │ /dsh-voice/ → 原 DSH 服务       ├─ /            静态前端（frontend/out）
                                         │ /live-demo/ → 原静态页          ├─ /auth|/v1|…  api.lightvela.com（真实 LightVela 登录）
                                                                          └─ /vela-im/    127.0.0.1:18787 身份服务
身份服务 ──创建 Agent──▶ hermes profile create + 插件 + 重启 vela-hermes-gateway ──▶ 每个 Agent 一个 Node IM worker
浏览器 / worker ──UserSig──▶ 腾讯云 IM（消息不经过本机服务）
```

## 搭建

```bash
# 1. Node 22 与 Hermes（隔离的 HERMES_HOME，不改动机器默认 node）
bash vela-im/deploy/test-env/bootstrap.sh
#    给 $HOME/vela-test/hermes-home 默认 profile 配置模型：config.yaml 的 model/providers 与 .env 中的 key
# 2. 腾讯 IM 密钥（不入库）
install -m 600 /dev/stdin $HOME/vela-test/secrets/im-secret.env <<< 'VELA_IM_SECRET_KEY=...'
# 3. 构建 vela-im
cd vela-im && npm ci && npm run build && cd ..
# 4. 构建前端（同源代理模式 + 开启 IM 实验室）
cd frontend && pnpm install
NEXT_PUBLIC_AUTH_API_BASE_URL=local-proxy NEXT_PUBLIC_VELA_IM_API_BASE=/vela-im NEXT_PUBLIC_REGION=cn pnpm build
rsync -a --delete out/ $HOME/vela-test/web/ && cd ..
# 5. 服务与代理
VELA_PUBLIC_ORIGIN=https://yuehuali.devcloud.woa.com bash vela-im/deploy/test-env/install.sh
```

把域名的入口反向代理 `location /` 指向 `http://127.0.0.1:13090`。前端构建内存不足（exit 137）时临时加 swap。

## 运维

```bash
systemctl status vela-im vela-hermes-gateway
journalctl -u vela-im -f
tail -f $HOME/vela-test/hermes-home/logs/gateway.log       # 各 Agent 的 vela_im 适配器上线情况
docker logs vela-web-proxy
```

## 验收

```bash
# 临时起一个只监听 loopback 的演示实例来签发两个测试自然人（不暴露到域名）
cd vela-im/server && set -a && . $HOME/vela-test/server.env && set +a
VELA_PORT=18788 VELA_DEMO_MODE=true node dist/main.js &
cd .. && VELA_TEST_URL=http://127.0.0.1:18788 VELA_AGENT_URL=http://127.0.0.1:18787 node scripts/e2e-agents.mjs
```

覆盖：Agent 注册与开通、自动与主人互为好友、单 Agent-单人单聊、多 Agent-非主人单聊、非主人命令被拒、
多 Agent-单人群聊、单 Agent-多人群聊、多 Agent-多人群聊（@ 谁谁回复，未 @ 不插话）。
