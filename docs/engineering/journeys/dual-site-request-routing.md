# Journey：国内与国际双站请求路由

## 目标

同一产品能力在 `lightvela.com` 与 `lightvela.ai` 按预期 locale、入口、后端和环境运行，不因前端文案相同就误认为路由一致。

## 链路

1. 域名/托管层把用户送到对应站点构建产物。
2. `frontend/src/lib/public-site-routing.ts` 决定前端站点与公开路由行为。
3. 客户文档按 cn/global/en/id 源选择 locale，生成层产出路由消费格式。
4. API 请求经对应域名进入 `service-gateway`，再到目标后端服务。
5. `infra_pulumi` inventory 与 `argocd` overlay 决定环境期望；Argo/集群证明实际收敛。

## 失败边界

- 页面语言错误：检查源 locale、路由映射和生成 parity。
- 页面正确但 API 跨区：检查公开 base URL、gateway 路由和环境 overlay。
- GitOps 正确但域名不可用：检查 Argo、Ingress/DNS/TLS 与浏览器网络证据。

## 验证

至少在两个生产域名或明确的预览环境分别验证页面 locale、API host、鉴权/支付门禁和关键入口；不要混用不同日期或不同环境的 dashboard 数据。
