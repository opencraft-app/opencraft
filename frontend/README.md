# Lightclaw Frontend

> Trigger note: README-only change to retrigger frontend release pipeline after Cloudflare preview path adjustments.
> Trigger note 2: README-only change to retrigger frontend update after release-frontend path correction.

## 部署形态

当前 `frontend` 支持两种形态：

- `shprod`：正式走 Kubernetes Pod 发布
- Cloudflare Pages：保留为静态托管备选路径

`shprod` 的标准入口是：

```bash
cd infra_pulumi
GOWORK=off go run ./cmd/infractl up --stack shprod
```

镜像构建统一走：

```bash
python3 scripts/build-release-image.py --service frontend --env shprod --tag <tag>
```

关键约束：

- 前端运行在 `frontend` namespace
- 域名走 `DOMAIN_FRONTEND_STATIC`
- 构建时会把 `VITE_AUTH_API_BASE_URL` 烘焙成当前 `DOMAIN_PUBLIC_API`
- `frontend/k8s/overlays/<env>/generated/` 是本地生成物，不提交 Git

## 1. 这是什么

这是 `Lightclaw` 的前端静态原型站。

技术栈：

- React
- Vite
- TypeScript
- Tailwind CSS v4
- shadcn/ui + Radix primitives
- React Router

当前定位不是完整生产系统，而是一个高保真、可交互、可静态托管的前端原型。重点验证的是：

- 品牌首页
- 手机号登录 / 注册
- 邀请码校验
- 免费体验档位确认
- Dashboard / Workspace / Settings 的第一版主路径
- 统一设计语言和后续可持续迭代的组件基础

当前主链路：

`Landing -> 手机号登录/注册 -> 邀请码（可选单独校验） -> Free 套餐确认 -> Dashboard -> Workspace / Settings`

## 2. 我们这轮前端具体做了什么

这轮不是单纯补页面，而是把整个前端原型重构成了一个后续可持续迭代的结构。

### 2.1 流程重置

- 移除了旧的 Onboarding 流程。
- 注册成功后统一先进入 `/plans/select`。
- 选择 `免费体验` 后直接进入 `/dashboard`。
- 前端认证主路径已收敛为 OAuth 与游客体验，手机号验证码链路已下线。
- 邮箱密码登录、邮箱注册、忘记密码等入口已收掉或重定向。

### 2.2 设计系统重构

- 统一了主题 token、字体、圆角、阴影、面板层次。
- 全站尽量回收到 `shadcn/ui` 组合，而不是页面里手搓散样式。
- 增加了共享设计原语，便于后续统一改风格。
- 品牌统一为 `Lightclaw`，整体调性是：
  - ToC
  - 中文优先
  - 精致、克制、轻科技
  - 控制台和营销页同源，但信息密度不同

### 2.3 落地的共享层

已经抽出来的共享层主要包括：

- 主题入口：`src/theme/`
- 全局字体与 CSS variables：`src/styles.css`
- 页面壳：`src/layouts/`
- 共享 UI：`src/components/ui/`
- 业务组件：`src/components/domain/`
- 站点级组件：`src/components/site/`

### 2.4 路由与守卫

- 营销页和认证页走 `MarketingLayout`
- 控制台走 `AppShellLayout`
- 使用路由守卫管理：
  - 未登录跳登录
  - 已登录但未确认套餐跳 `/plans/select`
  - 已确认套餐才可进入 `/dashboard` 和 `/bots/:id/*`

### 2.5 数据边界

页面本身不直接依赖 mock 文件。

统一通过 repository 层消费数据：

- `auth`
- `plans`
- `bots`

这样后续切换到真实 Go 后端时，页面层不需要整体推翻，只需要替换 repository 实现。

### 2.6 认证与后端接入策略

当前支持两种模式：

1. `mock` 模式
- 用于纯静态原型部署
- 登录、注册、套餐确认都在前端 fake repository 中完成
- 适合 Cloudflare Pages 纯静态演示

2. `http` 模式
- 对接 Go 认证服务
- 当前代码默认支持通过 `VITE_AUTH_API_BASE_URL` 接入
- 登录态通过 `/auth/session` 恢复

### 2.7 内部设计调试页

增加了一个内部页面：

- `/internal/style-lab`

这个页面不出现在主导航里，用于集中展示：

- Typography
- Button / Input / Select / Tabs / Dialog
- Card / InsetPanel / StatePanel
- Workspace patterns
- Plan card patterns

后续如果要统一调整设计语言，优先看这里。

## 3. 文件夹拓扑

下面是当前前端的主要目录结构和职责。

```text
frontend/
├─ backend/
│  └─ auth/
│     └─ Go 认证服务原型（可选，不是静态部署必需）
├─ dist/
│  └─ 构建产物
├─ public/
│  └─ 静态资源与 SPA fallback（例如 _redirects）
├─ scripts/
│  └─ 部署脚本，例如 Cloudflare Pages 发布脚本
├─ skills/
│  └─ 当前项目内记录的 agent skills
├─ src/
│  ├─ app/
│  │  └─ 应用入口拼装
│  ├─ assets/
│  │  └─ 本地字体等静态资源
│  ├─ components/
│  │  ├─ domain/
│  │  │  └─ 业务组件，如 PlanCard / InviteStatusCard / CodeInput
│  │  ├─ site/
│  │  │  └─ 站点级组件，如 BrandMark / footer / marketing header
│  │  └─ ui/
│  │     └─ 通用 UI 组件和 shadcn/ui 封装层
│  ├─ contexts/
│  │  └─ RepositoryContext / SessionContext
│  ├─ domain/
│  │  └─ 核心类型与计划目录等纯领域定义
│  ├─ layouts/
│  │  └─ MarketingLayout / AppShellLayout
│  ├─ lib/
│  │  └─ 通用工具函数
│  ├─ pages/
│  │  ├─ app/
│  │  │  └─ Dashboard / Workspace / Settings / Style Lab / PlanSelect
│  │  ├─ auth/
│  │  │  └─ 登录、注册、邀请码页及共享 auth shell
│  │  └─ marketing/
│  │     └─ Landing 与首页 hero 相关页面
│  ├─ repositories/
│  │  └─ fake / http repository 与统一接口定义
│  ├─ router/
│  │  └─ 路由表和守卫
│  ├─ services/
│  │  └─ 页面级异步资源辅助逻辑
│  ├─ test/
│  │  └─ 测试初始化
│  ├─ theme/
│  │  └─ 全局主题 preset
│  ├─ styles.css
│  └─ vite-env.d.ts
├─ .env.example
├─ DEPLOY_CLOUDFLARE.md
├─ package.json
└─ vite.config.ts
```

## 4. 整个前端的逻辑是怎么组织的

### 4.1 页面层只关心展示与交互

页面文件在：

- `src/pages/marketing/`
- `src/pages/auth/`
- `src/pages/app/`

这些页面不应该直接操作底层 mock 数据，也不应该自己拼装一套会话恢复逻辑。

### 4.2 会话状态统一放在 SessionContext

`src/contexts/session-context.tsx` 负责：

- 当前是否登录
- 当前用户是谁
- 是否确认过套餐
- 验证码冷却时间
- 首个 Bot ID
- 邀请码校验结果

也就是说：

- 页面不自己维护登录态真相
- 页面通过 `useSession()` 读写统一会话状态

### 4.3 数据访问统一走 repository

`src/repositories/types.ts` 定义了标准接口。

目前有两套实现：

- `src/repositories/fake-repositories.ts`
- `src/repositories/http-repositories.ts`

选择逻辑：

- 如果 `VITE_AUTH_API_BASE_URL=mock`，使用 fake auth
- 如果 `VITE_AUTH_API_BASE_URL` 是真实 URL，走 HTTP auth
- 如果没有显式配置，`localhost` 下默认尝试 `http://localhost:8081`
- 非本地域名且未配置时，回退到 fake auth

### 4.4 路由守卫控制整个漏斗

`src/router/index.tsx` + `src/router/guards.tsx` 控制访问规则：

- 未登录访问控制台：跳到登录
- 已登录但未确认套餐：跳到套餐页
- 已确认套餐：进入控制台
- 已登录访问 auth 页：自动跳到合适位置

### 4.5 主题和设计语言集中配置

统一设计入口：

- `src/theme/preset.ts`
- `src/styles.css`

可统一调整的内容包括：

- 背景色
- 品牌色
- 圆角
- 阴影
- 字号与字体栈
- 中文展示字体

所以后续要改整站风格，不应该逐页硬改 class，优先改这两层。

## 5. 当前页面与路由说明

### Marketing

- `/`
  - 品牌首页
  - 包含 hero、FAQ、法务 footer

### Auth

- `/auth/sign-in`
  - 手机号登录
- `/auth/sign-up`
  - 手机号注册
- `/auth/invite`
  - 邀请码校验

兼容重定向：

- `/auth/sign-up-code` -> `/auth/sign-up`
- `/auth/forgot-password` -> `/auth/sign-in`

### Plans

- `/plans/select`
  - 三档卡片：`免费体验 / Plus / Max`
  - 当前只有 `免费体验` 可选

### App

- `/dashboard`
- `/bots/:id/workspace`
- `/bots/:id/settings`

### Internal

- `/internal/style-lab`
  - 内部设计调试页，不在导航中暴露

## 6. 本地开发方法

### 安装依赖

```bash
pnpm install
```

### 本地开发

```bash
pnpm dev
```

### 构建

```bash
pnpm build
```

构建完成后会自动执行 `scripts/optimize-static-assets.mjs`：

- 只处理构建产物目录（`dist` / `dist-cn` / `dist-global`），不改源码图片
- 压缩产物里的 `.png` / `.jpg` / `.jpeg` 原图，并保留原文件
- 为每张原图生成同目录、同 basename 的 `.webp`
- 只把构建产物里的 `.html` / `.css` / `.js` / `.mjs` 本地引用改成 `.webp`
- 不改 `https://` / `//` 外链、`data:`、SVG、ICO、字体、视频

### 类型检查

```bash
pnpm check
```

### 单元测试

```bash
pnpm test
```

## 7. 前端发布方法

当前最稳定的发布路径是 **Cloudflare Pages**。

### 7.1 先登录 Cloudflare

```bash
npx wrangler login
npx wrangler whoami
```

### 7.2 选择 auth 模式

#### 方案 A：静态原型模式（推荐）

这种模式不依赖公网 Go auth 后端，最适合演示站。

```bash
export VITE_AUTH_API_BASE_URL=mock
pnpm build
CLOUDFLARE_PAGES_PROJECT_NAME=lightclaw pnpm deploy:cf
```

#### 方案 B：接真实 Go auth 后端

如果已经部署了 Go auth 服务，例如：

```bash
export VITE_AUTH_API_BASE_URL=https://auth.example.com
pnpm build
CLOUDFLARE_PAGES_PROJECT_NAME=lightclaw pnpm deploy:cf
```

### 7.3 预览分支发布

```bash
export VITE_AUTH_API_BASE_URL=mock
pnpm build
CLOUDFLARE_PAGES_PROJECT_NAME=lightclaw \
CLOUDFLARE_PAGES_BRANCH=preview \
pnpm deploy:cf
```

### 7.4 发布脚本说明

实际发布脚本在：

- `scripts/deploy-cloudflare-pages.mjs`

它本质上执行的是：

```bash
npx wrangler pages deploy dist --project-name lightclaw
```

并支持额外参数：

- `CLOUDFLARE_PAGES_BRANCH`
- `CLOUDFLARE_PAGES_COMMIT_HASH`

### 7.5 SPA 路由为什么能工作

前端使用 `BrowserRouter`，Cloudflare 上的深链刷新依赖：

- `public/_redirects`

没有这份文件，像 `/dashboard`、`/plans/select` 这种路径刷新会出错。

## 8. 需要的环境变量 / 密钥

这里写的是“需要配置什么”，不是实际密钥值。

**不要把真实值写进仓库。**

### 前端运行/发布需要

#### `VITE_AUTH_API_BASE_URL`

用途：指定认证后端地址。

示例：

```bash
VITE_AUTH_API_BASE_URL=http://localhost:8081
```

静态原型模式：

```bash
VITE_AUTH_API_BASE_URL=mock
```

#### `CLOUDFLARE_PAGES_PROJECT_NAME`

用途：Cloudflare Pages 项目名。

当前默认项目名：

```bash
CLOUDFLARE_PAGES_PROJECT_NAME=lightclaw
```

#### `CLOUDFLARE_PAGES_BRANCH`（可选）

用途：指定 Pages 分支环境。

#### `CLOUDFLARE_PAGES_COMMIT_HASH`（可选）

用途：将部署和某个提交关联。

### Cloudflare 认证密钥（二选一）

#### 方案 A：本机交互登录

```bash
npx wrangler login
```

这种方式通常不需要你手动写 token。

#### 方案 B：CI / 非交互发布

需要：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

注意：

- 这两个属于真正的密钥/账号配置
- 不应该写死到仓库里
- 应该配置在 CI、Shell profile 或部署平台的环境变量里

## 9. 关于 Go 认证后台

当前前端已经支持接入 Go 认证后台，但不是静态部署必需。

后端原型在：

- `backend/auth/`

前端目前预留的核心接口形态是：

- `POST /auth/sms/send`
- `POST /auth/sms/verify`
- `POST /auth/invite/validate`
- `GET /auth/session`
- `DELETE /auth/session`
- `GET /subscriptions/current`
- `POST /subscriptions/checkout`

如果后端未部署到公网，最推荐的前端部署方式仍然是：

- `VITE_AUTH_API_BASE_URL=mock`

## 10. TAT HTTP Virtual Fetch

前端现在提供了一层基于 TAT `tssh` 端口转发能力的 HTTP 虚拟访问 SDK。它的目标不是让业务代码直接操作裸的 `TencentTsshProxyClient` 字节流，而是把被纳管机器里的 loopback HTTP 服务包装成接近浏览器原生 `fetch()` 的调用方式。

典型场景是：被纳管 VM 内已经监听了 Hermes API Server 和 Web Dashboard：

```text
VM 内部：
- API Server: 127.0.0.1:8642
- Web Dashboard: 127.0.0.1:9119
```

前端可以通过 TAT 安全通道访问它：

```text
frontend fetch()
  -> TAT SessionAuth
  -> TAT PtyProxyNew
  -> VM 127.0.0.1:8642 / 9119
  -> HTTP/1.1 request / response
```

核心文件：

- `src/lib/tencent-tssh-proxy-client.ts`：底层 TAT `PtyProxy` 字节流实现
- `src/lib/tat-http-virtual-client.ts`：前端友好的 HTTP / fetch 兼容封装
- `src/lib/__tests__/tat-http-virtual-client.test.ts`：HTTP over TAT proxy 的行为测试

### 10.1 Hermes API 文档入口

Hermes Agent 官方文档入口：

- API Server 文档：<https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/>
- Web Dashboard 文档：<https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard/>
- 文档首页：<https://hermes-agent.nousresearch.com/docs/>
- GitHub：<https://github.com/NousResearch/hermes-agent>

API Server 文档是前端对接时最重要的页面。它说明了 Hermes 暴露的是 OpenAI-compatible HTTP endpoint，默认本地监听：

```text
http://127.0.0.1:8642
```

重点接口包括：

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/models`
- `GET /v1/capabilities`
- `GET /health`
- `GET /health/detailed`
- `POST /v1/runs`
- `GET /v1/runs/{run_id}`
- `GET /v1/runs/{run_id}/events`
- `POST /v1/runs/{run_id}/stop`
- `/api/sessions/*`
- `/api/jobs/*`
- `GET /v1/skills`
- `GET /v1/toolsets`

鉴权使用 Hermes 自己的 bearer token：

```text
Authorization: Bearer <API_SERVER_KEY>
```

所以在本项目里，TAT 只负责把请求安全送到被纳管 VM 的 `127.0.0.1:8642`；具体 HTTP path、request body、streaming 行为和 bearer token 规则，以 Hermes API Server 官方文档为准。

Web Dashboard 文档说明了 `hermes dashboard` 提供的是浏览器 UI 和一组 dashboard REST API，默认本地监听：

```text
http://127.0.0.1:9119
```

因此本项目同时提供 API 端口和 WebUI 端口的 HTTP virtual fetch 入口。

### 10.2 Hermes API 默认入口

如果目标就是 VM 内的 Hermes `127.0.0.1:8642`，直接使用 `createTatHermesFetch`：

```ts
import { createTatHermesFetch } from "@/lib/tat-http-virtual-client";

const tatFetch = createTatHermesFetch(bootstrap);

const response = await tatFetch("/v1/models");
const models = await response.json();

const completion = await tatFetch.json("/v1/chat/completions", {
  json: {
    model: "hermes",
    messages: [{ role: "user", content: "hello" }],
  },
});

tatFetch.close();
```

这里的 `bootstrap` 是后端返回的 TAT terminal session 信息，里面包含 `wsUrl`、`sessionId`、`instanceId`、`ownerUin`、`appId` 等 TAT 鉴权和连接参数。

默认目标等价于：

```ts
{
  ip: "127.0.0.1",
  host: "127.0.0.1",
  port: 8642,
}
```

也就是说，浏览器里看起来是普通 HTTP 调用，实际请求会通过 TAT proxy 打到被纳管节点自己的 `127.0.0.1:8642`，不是访问用户浏览器所在机器的本地端口。

### 10.3 Hermes WebUI 默认入口

如果目标是 VM 内的 Hermes Web Dashboard `127.0.0.1:9119`，使用 `createTatHermesWebFetch`：

```ts
import { createTatHermesWebFetch } from "@/lib/tat-http-virtual-client";

const webFetch = createTatHermesWebFetch(bootstrap);

const html = await webFetch("/").then((response) => response.text());
const dashboardState = await webFetch.json("/api/state");

webFetch.close();
```

默认目标等价于：

```ts
{
  ip: "127.0.0.1",
  host: "127.0.0.1",
  port: 9119,
}
```

注意：这个入口可以读取 Web Dashboard 的 HTML、静态资源和 REST API，但它仍然是 fetch 级别的虚拟 HTTP 访问。如果要把完整 WebUI 直接嵌进 iframe 或让用户浏览器地址栏访问，需要后端或 Tauri/Rust 本地 HTTP gateway 做真实 HTTP 反向代理。

当前 settings 页已经提供了一个 `WebUI` tab。这个 tab 使用专用 Service Worker 暴露同源代理路径：

```text
/__tat_hermes_proxy/<botId>/*
```

Service Worker 只拦截这个 scope 下的请求，不会拦截 LightVela 全站的 `/api/*` 或 `/assets/*`。iframe 加载 Hermes Web Dashboard 时，页面 broker 会把这些代理请求转成 `createTatHermesWebFetch()` 调用，再通过 TAT 访问 VM 内 `127.0.0.1:9119`。

因为 Hermes WebUI 可能把资源写成根路径，例如 `/assets/app.js` 或 `/api/state`，tab 会对 HTML / CSS / JS 做轻量路径重写，把这些请求改到 `/__tat_hermes_proxy/<botId>/...` 下，否则浏览器会把它们当成 LightVela 自己域名下的请求，无法进入 TAT 代理。

### 10.4 自定义 VM 内端口

除了 Hermes 的 `8642` / `9119` 快捷入口，调用方必须能自由指定 VM 内任意 HTTP 端口。最直接的入口是 `createTatPortFetch`：

```ts
import { createTatPortFetch } from "@/lib/tat-http-virtual-client";

const serviceFetch = createTatPortFetch(bootstrap, 7777);

const response = await serviceFetch("/custom/path");
const data = await response.text();

serviceFetch.close();
```

上面的请求会通过 TAT proxy 访问被纳管 VM 内：

```text
127.0.0.1:7777
```

如果需要指定 VM 内其他 IP 或自定义 HTTP `Host` header：

```ts
const serviceFetch = createTatPortFetch(bootstrap, 8080, {
  ip: "127.0.0.1",
  host: "my-service.local",
});
```

也可以用更完整的 `createTatHttpFetch`：

```ts
import { createTatHttpFetch } from "@/lib/tat-http-virtual-client";

const tatFetch = createTatHttpFetch(bootstrap, {
  target: {
    ip: "127.0.0.1",
    host: "my-service.local",
    port: 8080,
  },
});

const health = await tatFetch.json<{ ok: boolean }>("/health");
```

其中：

- `ip` 是 TAT agent 在 VM 内要连接的地址
- `port` 是 VM 内目标服务端口
- `host` 用于 HTTP `Host` header，不传时默认等于 `ip`

单次请求也可以覆盖目标端口：

```ts
const tatFetch = createTatPortFetch(bootstrap, 8642);

await tatFetch("/metrics", {
  target: {
    ip: "127.0.0.1",
    host: "127.0.0.1",
    port: 9090,
  },
});
```

### 10.5 已支持能力

- `GET` / `POST` 等常见 HTTP method
- `headers`
- `AbortSignal`
- `json` 请求体快捷写法
- 原生 `Response` 返回对象
- `tatFetch.json<T>()` 快捷 JSON 响应解析
- `Content-Length` 响应体
- `Transfer-Encoding: chunked` 响应体

### 10.6 当前边界

- 只支持明文 HTTP 目标；VM 内 `127.0.0.1` 服务通常不需要 TLS。
- 当前请求体是一次性写入，适合普通 API 请求；大文件上传需要再补 request streaming。
- 每次 `fetch()` 会打开一个 TAT proxy channel，响应结束后关闭；这比复用连接更简单，也更符合当前 TAT proxy 的产品化稳定性要求。
- 这不是浏览器本地端口监听器。外部进程不能直接 `curl localhost` 访问它；如果要让本机其他程序也能用，需要再做 Tauri/Rust 本地 HTTP gateway。

## 11. 当前已知取舍

### 已经有的优点

- 可直接静态托管
- 页面不绑死 mock 数据
- 认证、套餐、Bot 数据边界清晰
- 设计语言已收口到 token 和共享组件层
- 适合继续做视觉统一和后端替换

### 当前还不是最终生产形态的地方

- auth 模式现在仍支持自动回退到 mock
- mock repository 仍然带有少量人为延迟
- 不是完整商业化产品
- 当前主要用于演示和高保真前端验证

## 12. 接手这个项目时，建议先看哪些文件

如果你是新接手，建议按下面顺序读：

1. `src/router/index.tsx`
2. `src/router/guards.tsx`
3. `src/contexts/session-context.tsx`
4. `src/repositories/types.ts`
5. `src/repositories/http-repositories.ts`
6. `src/repositories/fake-repositories.ts`
7. `src/layouts/marketing-layout.tsx`
8. `src/layouts/app-shell-layout.tsx`
9. `src/theme/preset.ts`
10. `src/styles.css`

## 13. 一句话总结

这是一个已经完成了主链路、设计系统初步收口、支持静态发布、并预留了 Go 认证后台接入边界的 Lightclaw 前端原型。

<!-- ci: trigger frontend native EdgeOne subpipeline fanout verification at 2026-05-16T03:31:48+08:00 -->
