# mono2 接入 tea-sdk-lightclaw 本地热更新联调

本文档说明如何在 `mono2/frontend` 中，对 `tea-sdk-lightclaw` SDK 源码做**本地热更新（HMR）联调**：直接加载兄弟目录里 SDK 的 TypeScript 源码，改 SDK 代码即时生效，无需在 SDK 侧执行 build。

## 一、前置条件

- `mono2` 与 `tea-sdk-lightclaw` 两个仓库需**平级放在同一父目录**下，Vite 通过相对路径 `../../tea-sdk-lightclaw` 定位 SDK 源码（见 `vite.config.ts` 的 `LOCAL_SDK_ROOT`）。

  ```
  父目录/
  ├── mono2/
  │   └── frontend/
  └── tea-sdk-lightclaw/
  ```
- 已安装 [whistle](https://wproxy.org/whistle/) 并完成证书信任（用于把线上域名代理到本地）。

## 二、操作步骤

### 1. 启动 mono2 前端（本地 SDK 模式）

在 `mono2/frontend` 目录下，按站点选择启动命令：

```bash
# 国内站
pnpm dev:local

# 国际站
pnpm dev:local:global
```

> 这两个脚本会设置 `VITE_LOCAL_SDK=1`，Vite 据此把 `@tencent/tea-sdk-lightclaw` 的 import 别名指向 SDK 本地源码入口 `tea-sdk-lightclaw/src/index.ts`，并排除预打包，从而支持源码级 HMR。

### 2.（可选）SDK 侧无需 build

本地源码模式（`VITE_LOCAL_SDK=1`）下，Vite 直接读取 SDK 的 `.ts/.tsx` 源码，**修改后由 mono2 这边的 Vite 触发 HMR 即时生效**，因此 SDK 侧通常**无需**执行 `npm run dev` / `npm run build`。仅当需要验证 SDK 的产物构建时才单独运行。

### 3. 用 whistle 把线上域名代理到本地

使用 whistle 将打开的站点域名代理到本地 Vite server（默认 `127.0.0.1:5173`）。下面以 `lightclaw.pages.dev` 为例，**实际使用时把域名替换成你正在调试的站点域名**：

```
# 1. 入口 HTML（必须）
#    否则拿到的是线上打包后的 HTML，里面引用的是线上 hash 文件名
https://lightclaw.pages.dev/            127.0.0.1:5173
https://lightclaw.pages.dev/index.html  127.0.0.1:5173

# 2. Vite 虚拟模块与源码（dev 下 JS 都从这些路径走）
https://lightclaw.pages.dev/src/            127.0.0.1:5173
https://lightclaw.pages.dev/@vite/          127.0.0.1:5173
https://lightclaw.pages.dev/@react-refresh  127.0.0.1:5173
https://lightclaw.pages.dev/@id/            127.0.0.1:5173
https://lightclaw.pages.dev/@fs/            127.0.0.1:5173
https://lightclaw.pages.dev/node_modules/   127.0.0.1:5173

# 3. 所有 .js / .ts / .tsx / .jsx / .mjs / .map 文件
/^https:\/\/lightclaw\.pages\.dev\/.*\.(js|mjs|ts|tsx|jsx|map)(\?.*)?$/ 127.0.0.1:5173

# 4. CSS 文件
/^https:\/\/lightclaw\.pages\.dev\/.*\.css(\?.*)?$/ 127.0.0.1:5173

# 5. HMR 热更新通道（不加就无法热更）
#    左侧 host 需与页面实际连接的 HMR 域名一致
wss://lightclaw.pages.dev/  ws://127.0.0.1:5173
```

> ⚠️ 注意：上面所有规则的左侧域名要保持一致，统一替换成你正在调试的站点域名（例如 `lightvela.com`、`lightvela.ai` 等）。

## 三、远程域名 HMR 配置

> ⚠️ **`.env.local` 不进 git，每位开发者需自行创建。** 该文件按设计仅本地生效、不纳入版本控制（见下文「仅影响本地 dev，不进构建产物」），所以新克隆 `mono2` 后本地不会有它——若不手动创建并配置远程 HMR，用线上域名联调时 HMR 会一直尝试直连 `localhost:5173` 而连不上。推荐配置：远程 HMR 指向 `lightvela.tencent.com`（国内正式域反代联调），该域名已在 `vite.config.ts` 默认放行列表内，按下面步骤创建 `.env.local` 即可；换其它域名时同样在此调整。

当通过线上域名（而非 `localhost`）访问本地服务时，Vite 默认的 HMR 直连 `localhost:5173` 会失败，需要显式告诉 Vite 用外部域名建立 HMR WebSocket。

当通过线上域名（而非 `localhost`）访问本地服务时，Vite 默认的 HMR 直连 `localhost:5173` 会失败，需要显式告诉 Vite 用外部域名建立 HMR WebSocket。

在 `mono2/frontend` 下新建 `.env.local`（仅影响本地 dev，不进构建产物、不入 git），把下面这份示例整段复制进去即可——默认按推荐域名 `lightvela.tencent.com` 配好，开箱即用：

```bash
# frontend/.env.local
# 放行额外的访问域名（逗号分隔；.xxx 前缀表示泛匹配所有子域）
VITE_DEV_ALLOWED_HOSTS=lightclaw.pages.dev,.pages.dev

# 开启远程 HMR：填你代理的外部域名
VITE_DEV_HMR_HOST=lightclaw.pages.dev
VITE_DEV_HMR_PROTOCOL=wss
VITE_DEV_HMR_CLIENT_PORT=443
```

> 三个 `VITE_DEV_HMR_*` 变量的含义：`HOST` = HMR WebSocket 要连的域名（而非默认 `localhost`）；`PROTOCOL=wss` = https 页面必须用加密 ws；`CLIENT_PORT=443` = 浏览器端连接的端口（对齐 whistle 监听的 443，而非 dev server 本地的 5173）。dev server 自身仍监听本地 `5173`，这几行只改「浏览器里那段 HMR 客户端脚本」的连接目标。

> [`vite.config.ts`](../../frontend/vite.config.ts) 已内置放行 Cloudflare Pages 与 lightvela / lightclaw 系列常用域名，完整列表见 `vite.config.ts`；只有调试列表之外的域名时才需要追加 `VITE_DEV_ALLOWED_HOSTS`。

## 四、后端 API 域名映射

当用 whistle 把线上域名代理到本地时，**前端代码本身仍按当前浏览器域名（`window.location.hostname`）决定要请求哪个后端 Auth API**。这段逻辑在 [`frontend/src/lib/auth-api-base.ts`](../../frontend/src/lib/auth-api-base.ts) 的 `resolveConfiguredAuthApiBaseUrl()`：

1. 优先读环境变量 `VITE_AUTH_API_BASE_URL`（`mock` → 走 mock；`local-proxy` → 走当前域名 + vite proxy；其它值 → 直接用该地址）。
2. 未配置环境变量时，按 hostname 匹配内置映射表。

当前内置的 hostname → Auth API 映射：

| 浏览器 hostname | Auth API Base |
|---|---|
| `localhost` / `127.0.0.1` | `https://lightclaw.tech` |
| `lightclaw.tech` / `www.lightclaw.tech` / `lightclaw.pages.dev` / `*.lightclaw.pages.dev` | `https://lightclaw.tech` |
| `preview.lightclaw.cn` / `lightclaw.cn` | `https://api.lightclaw.cn` |
| `lightclaw.site` / `www.lightclaw.site` | `https://api.lightclaw.site` |
| `lightvela.tencent.com` / `www.lightvela.tencent.com` | `https://api.lightvela.com` |

> ⚠️ **尚未配置的域名**：`lightvela.ai` 目前**不在**映射表内（`lightvela.tencent.com` 已映射到后端 `https://api.lightvela.com`）。虽然 `vite.config.ts` 的 `defaultAllowedHosts` 已放行该域名（dev server 层允许访问），但 `auth-api-base.ts` 没有为它映射后端地址——用这类域名访问时，若未显式设置 `VITE_AUTH_API_BASE_URL`，`resolveConfiguredAuthApiBaseUrl()` 会返回 `null`，认证类请求将无可用基地址。

临时联调可在 `.env.local` 设置环境变量绕过映射表：

```bash
# 直接指定后端 Auth API 地址（构建期注入）
VITE_AUTH_API_BASE_URL=https://api.lightvela.com
```

若要正式启用某个新域名，应在 `auth-api-base.ts` 增加对应分支，例如：

```ts
if (hostname === "lightvela.ai" || hostname === "www.lightvela.ai") {
  return "https://api.lightvela.com"; // 替换为该域名对应的后端 API
}
```

## 五、常见问题排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 页面加载的还是线上代码 | 入口 HTML 没被代理 | 确认规则 1（HTML / index.html）已生效 |
| 改 SDK 源码不热更 | 没用 `dev:local` 启动，或 HMR 通道没代理 | 用 `pnpm dev:local` 启动，并补全规则 5 的 `wss` 代理 |
| 控制台报域名未放行 | 访问域名不在 `allowedHosts` 内 | 配置 `VITE_DEV_ALLOWED_HOSTS` |
| HMR WebSocket 连接失败 | 远程域名未配置 HMR host | 配置 `VITE_DEV_HMR_HOST` 等变量 |
| 登录/认证请求 404 或地址为空 | 当前域名未在 `auth-api-base.ts` 配置（如 `lightvela.ai`） | 设 `VITE_AUTH_API_BASE_URL`，或在 `auth-api-base.ts` 补域名分支 |
