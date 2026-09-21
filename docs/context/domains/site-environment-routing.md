---
id: site-environment-routing
type: domain
scope: 国内与国际站边界、环境路由、域名和 locale 行为。
triggers: ["site", "environment", "locale", "international", "domain"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - docs/engineering/domains/site-environment-routing.md
  - frontend/src/lib/public-site-routing.ts
  - argocd/apps/sgprod/README.md
  - argocd/apps/shprod/README.md
  - frontend/AGENTS.md
status: active
reviewed_at: 2026-08-25
review_due: 2026-11-23
revision: 2.0.0
precedence: domain
derived: true
---

# 站点与环境路由

> 派生摘要：正式领域知识见 `docs/engineering/domains/site-environment-routing.md`；本页只保留影响 Agent 路由和实现决策的最小事实。

## 适用场景

任务变更国内或国际站行为、环境选择、域名路由、locale、区域门禁功能或部署 overlay 时使用。

## 影响决策的事实

- 国内与国际站是独立交付面。一个环境中功能正常不证明另一环境正确。
- `sgprod` 与 `shprod` 是不同生产 overlay；不得通过相互复制 overlay 发布。
- `beijing-sandbox` 用于测试交付，不能证明生产行为。
- 站点能力通常包含前端门禁、网关/config 门禁和后端 contract 三部分；仅 UI 变更不能视为全站启用。
- Locale 文案和站点 copy 是产品内容；已有 site helper 或生成类型时，不得硬编码 locale 推断。

## 代码锚点

- `frontend/src/lib/public-site-routing.ts`
- `frontend/src/domain/types.ts`
- `argocd/apps/sgprod/`
- `argocd/apps/shprod/`
- `service-gateway/k8s/overlays/`

## 验证

运行前端类型检查和聚焦组件测试。环境或 overlay 变更要求 manifest 验证和 release-domain 验证门禁。

## 不得推断

线上 DNS、证书和 edge-cache 状态是运行时事实。读取当前环境证据，不能从仓库路径推断。
