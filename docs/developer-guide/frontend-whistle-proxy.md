# Frontend Whistle 本地热更新联调代理

本文档说明如何通过 whistle 将生产域名代理到本地 Next.js dev server，实现源代码级 HMR 联调。

## 前置条件

- [whistle](https://wproxy.org/whistle/) 已安装并启动（管理页 `http://127.0.0.1:8899`）
- 浏览器代理插件（推荐 [SwitchyOmega](https://chrome.google.com/webstore/detail/proxy-switchyomega/padekgcemlokbadohgkifijomclgjgif)）

## 操作步骤

### 1. 信任 whistle HTTPS 证书（首次）

打开 `http://127.0.0.1:8899` → **HTTPS** → 下载 rootCA.crt → 双击安装 → macOS 钥匙串中设为「始终信任」。只需一次。

### 2. 启动本地 dev server

```bash
cd frontend && pnpm dev            # 默认
cd frontend && pnpm dev:cn         # 国内站
cd frontend && pnpm dev:global     # 国际站
```

端口已内置在 `package.json`，默认 `localhost:5174`。

### 3. 配置 whistle 规则

打开 `http://127.0.0.1:8899` → **Rules** → 新建规则 → 粘贴以下内容 → 勾选启用。

**重要**：粘贴前将 `lightvela.com` 全局替换为实际调试的域名。


```
# ---- 域名替换说明 ----
# 以下用 lightvela.com 作为示例。使用前全局替换为实际调试的域名：
#   - 国内站        ：lightvela.com
#   - 国内站（www） ：www.lightvela.com
#   - 国际站        ：lightvela.ai
#   - 腾讯云反代    ：lightvela.tencent.com
#   - Pages 预览    ：xxx.lightclaw.pages.dev

# === 1. 入口 HTML（必须）===
lightvela.com 127.0.0.1:5174
lightvela.com/index.html 127.0.0.1:5174

# === 2. Next.js 构建产物 ===
lightvela.com/_next/ 127.0.0.1:5174

# === 3. 源码 ===
lightvela.com/src/ 127.0.0.1:5174
lightvela.com/node_modules/ 127.0.0.1:5174

# === 4. JS / TS / CSS 兜底 ===
/^https?:\/\/lightvela\.com\/.*\.(js|mjs|cjs|ts|tsx|jsx|css|map)(\?.*)?$/ 127.0.0.1:5174

# === 5. HMR WebSocket（必须）===
wss://lightvela.com 127.0.0.1:5174
ws://lightvela.com 127.0.0.1:5174
```

### 4. 浏览器代理指向 whistle

SwitchyOmega 新建情景模式，代理服务器 `127.0.0.1:8899`。

### 5. 验证

浏览器打开目标域名，DevTools Network 中检查 HTML / JS 是否来自 `127.0.0.1:5174`，保存源码文件看页面是否热更新。

## 常见问题

| 现象 | 原因 | 处理 |
|------|------|------|
| 页面还是线上代码 | 规则 1（HTML）没生效 | 检查域名替换是否正确 |
| 改源码不热更 | HMR WebSocket 没通 | 补上 `wss://` 规则 |
| 域名未放行 | 不在 `allowedDevOrigins` | `.env.local` 中加 `NEXT_PUBLIC_ALLOWED_HOSTS` |
| WebSocket 连接失败 | HTTPS 证书未信任 | 重新信任 whistle 根证书 |
