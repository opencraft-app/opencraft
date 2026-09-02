# 国际站 V2 首页性能优化设计

**日期：** 2026-09-02

**基线：** `origin/master` @ `e287348a5152d4dc751c0db51db9a3983dd1ec07`

**规模：** M。改动限定在国际站 V2 首页的 client boundary、评价头像生成和场景子按钮；不修改 API、鉴权、计费、发布或完整 i18n 运行时协议。fragment 边界建议已用真实产物验证并撤回。

## 目标

在不改变首页文案、视觉结构、语言路由和登录行为的前提下，先移除四类已有直接证据的浪费或缺陷：

1. 首页两个 client entry 重复携带同一组 eager i18n 字典；
2. 验证“Server Component 直出可减少约 97 KB RSC”这一建议是否在当前 Next App Router 静态导出中成立；
3. 折叠下方评价头像未延迟加载，并使用远大于 32×32 展示尺寸的原图；
4. 18 个 `.scene__sub` 原生按钮只响应 `mouseenter`，键盘产生的 `click` 不生效。

## 方案选择

### 方案 A：分阶段收敛，当前采用

本阶段完成 i18n client boundary Q1、评价头像资源优化和场景按钮 a11y，并以真实构建验证 fragment 服务端直出假设。每项都有独立 RED/GREEN 测试与构建量化；动效脚本生命周期另起第二阶段。

优点是 diff 可审、收益可单独归因，并且不会在没有完整浏览器回归前重写三段外部 IIFE。代价是 timer/listener cleanup、打字机布局抖动和自定义资源缓存策略不会在本阶段解决。

### 方案 B：一次完成全部审查项

除方案 A 外，同时把 `runtime.js`、`hero-chat.js`、`scene-wheel.js` 改为统一 `mount(): cleanup` 协议，重写脚本装载并调整资源缓存。收益覆盖完整，但会同时改变生成脚本、运行顺序、动效时序和部署缓存契约，难以从一次构建或 smoke 中定位回归。

### 方案 C：只做 i18n Q1

只收窄 client boundary，以最小代码验证能否消除一份约 302 KB Brotli 字典 chunk。风险最低，但会留下已确认的 fragment 重复、头像流量和键盘缺陷。

## 架构设计

### 1. i18n client boundary Q1

`PublicSiteAppProviders` 与 `PublicSiteLocaleBridge` 当前位于同一个 `'use client'` module；前者被 `(site)/layout.next.tsx` 引用，后者通过 `@/i18n/t` 静态引入 eager 字典。先把 App Provider 树移动到不导入 `@/i18n/t` 的独立 client module，保持现有 export 兼容层供页面调用方使用。

第一次真实构建证明仅拆 module 不足：依赖继续沿 `PublicSiteAppProviders → RepositoryProvider → http-repositories.ts → t("我的Hermes")` 进入 `@/i18n/t`。该文件只有这一处翻译调用。用户确认采用方案 A 后，本设计增加一个窄适配器：使用 `react-i18next` 已注册的全局实例翻译固定生成 key，未初始化或空结果时回退“我的Hermes”，从而让 repository 层不再静态导入完整字典资源图。

固定 key 必须由测试与 `zh-to-key.json["我的Hermes"]` 对齐；适配器不复制七份翻译、不初始化第二个 i18n 实例，也不改变现有字典和 locale 注册表。provider 拆分后，header/cookie 在完整 locale 入口加载前会触发 `NO_I18NEXT_INSTANCE`，因此持久 shell 只用 `setI18n` 注册共享空实例，并在这两个提前渲染的 hook 上显式设置 `useSuspense: false`。这样既不全局修改 react-i18next 默认值，也不初始化实例或读取任何字典；完整入口之后继续使用同一个单例。

该修改不改变 locale 初始化、`LocaleOverrideProvider`、SSR hydration 或字典加载协议。是否成功只以真实 `build:global` 首页产物为准：若 `/` 仍包含两份完整 key 集合，则停止扩展实现并重新追踪 layout 依赖，不顺手异步化字典。

### 2. fragment 服务端直出假设：验证后撤回

曾实现 `InternationalHomePage` 由 Server Component 自己渲染 `dangerouslySetInnerHTML`，`InternationalHomeRuntime` 只接收 `locale`。rendering 测试通过，但真实 `build:global` 证明 Next 仍把完整 fragment 作为 Server Component 节点的 `__html` 写入 Flight/RSC：`__PAGE__.txt` 为 102,321 B，代表性首页长句仍命中一次，最终 `index.html` 中正文仍出现两次。

因此该调整只改变序列化归属，没有拿掉约 97 KB 网络载荷，不能作为打开速度优化。实现与对应测试已撤回，保留原有 `markup` client prop；后续若要真正消除重复，需要改变 App Router 输出/导航协议或页面交付模型，不能只移动 React 边界。

### 3. 评价头像

在导入脚本的生成阶段识别 `.voice .tcard img`：

- 添加 `loading="lazy"`、`decoding="async"`、`width="32"`、`height="32"`；
- 为唯一评价头像生成最大 64×64 的 WebP 资源并改写引用；
- `lightvela-reply-avatar.png` 等聊天区图片不进入本规则；
- 七个 locale fragment 使用相同资源映射，避免多语言产生重复文件。

若本机缺少稳定的图片转换工具，先保留原格式只完成 lazy 与尺寸声明，并在结果中明确未实现的压缩收益，不引入新 npm 依赖。

### 4. 场景子按钮 a11y

复用单一 `activate(index)` 逻辑，同时绑定 `mouseenter` 和 `click`。浏览器 smoke 发现内置浏览器的 Enter 只聚焦而未合成 click，因此增加只处理 Enter/Space 的 `keydown` 兜底并 `preventDefault()`；同时维护 `aria-pressed`，Tab 聚焦本身不切换内容。

## 测试与测量

- RED/GREEN：provider/repository module 边界静态契约；默认 Agent 名固定 key 与生成资源一致、已注册 i18n 与中文兜底行为；七 locale 评价头像属性/资源；18 个场景按钮 click、Enter、Space 契约。
- 回归：国际首页现有 rendering、routing、locale、链接和资源测试。
- 质量门禁：`pnpm check`、`pnpm i18n:check`、`pnpm build:global`、`git diff --check`。
- 产物量化：记录 `/` 的 script 数、现代浏览器压缩 JS、完整字典 chunk 数、原始 HTML、RSC 中 fragment 命中、评价头像初始请求数和唯一资源字节数。
- 浏览器 smoke：桌面与 390px；七 locale 至少验证 SSR 正文、语言切换、场景 click、键盘 Enter/Space、无控制台新增错误。

## 成功标准

- 首页真实 global 构建最多包含一份完整 eager 字典 key 集合；若未达到，提供构建证据并不宣称去重成功。
- fragment 边界实验以真实 RSC 产物判断；若 payload 未减少则撤回，不宣称 97 KB 收益。
- 18 个 `.scene__sub` 可通过鼠标 hover、触屏/鼠标 click 和键盘 Enter/Space 激活。
- 评价头像不参与首屏 eager 请求，并具有稳定 intrinsic dimensions；如完成 64×64 WebP，记录源资源与新资源总字节差。
- 国内站不启用 V2 首页，既有公开页面、登录态和 locale 行为不变。

## 本阶段不做

- 不异步化 `src/i18n/index.ts`，不移除 locale，不改变 hydration 时序。
- 不拆完整 marketing layout，不动态加载登录弹窗或 Repository/OpenClaw provider。
- 不重写三段动效 IIFE，不声称已解决 timer/listener/observer 泄漏。
- 不修改 CDN、EdgeOne、Cloudflare 或 Nginx 缓存头。
- 不以单轮 Lighthouse 或静态体积推导线上 LCP 收益。
- 未经用户单独确认，不 commit、push、创建 MR 或发布。
