# Journey：国内与国际双站请求路由

## 目标

同一产品能力在 `lightvela.com` 与 `lightvela.ai` 按预期 locale、入口、后端和环境运行，不因前端文案相同就误认为路由一致。

## 链路

1. 域名/托管层把用户送到对应站点构建产物。
2. `frontend/src/lib/public-site-routing.ts` 决定前端站点与公开路由行为。
3. 公开首页入口根据构建站点选择对应内容源：国内站使用国内语境的 `zh-CN` 首页片段和裸路径链接，国际站使用默认英文与多语言片段。
4. 客户文档按 cn/global/en/id 源选择 locale，生成层产出路由消费格式；首页或页脚引用文档时必须确认目标 slug 在当前站点可访问。
5. Blog 当前只在国际站开放；国内站请求 `/blog` 或本地化 Blog 路由应进入 notFound 边界，避免把国际内容入口误暴露到 `lightvela.com`。
6. API 请求经对应域名进入 `service-gateway`，再到目标后端服务。
7. `infra_pulumi` inventory 与 `argocd` overlay 决定环境期望；Argo/集群证明实际收敛。

## 失败边界

- 页面语言错误：检查源 locale、路由映射和生成 parity。
- 公开首页文案或 CTA 串站：检查首页 fragment 选择、构建期 `isCN` / `isGlobal` 分支、裸路径与 locale 前缀规则。
- Blog 在国内站出现：检查 App Router 中 `!isGlobal` 的 notFound 边界和导航入口。
- 页脚或首页文档链接 404：检查 `frontend/src/content/docs/**` 的源文档、生成 slug 和静态链接测试。
- 页面正确但 API 跨区：检查公开 base URL、gateway 路由和环境 overlay。
- GitOps 正确但域名不可用：检查 Argo、Ingress/DNS/TLS 与浏览器网络证据。

## 验证

至少在两个生产域名或明确的预览环境分别验证页面 locale、API host、鉴权/支付门禁和关键入口；不要混用不同日期或不同环境的 dashboard 数据。涉及公开首页或 Blog 时，还要验证：

- 国内站首页展示国内 CTA、国内渠道、国内合规页脚和国内文档链接。
- 国际站首页展示默认英文和已发布 locale 的对应权益文案、AI companion 语境和图片资源。
- 国际站 Blog 列表与文章页可访问；国内站 Blog 路由保持不可访问。
- 静态 fragment 中的站内链接无缺失，外链保留必要的 `target` / `rel` 属性。
