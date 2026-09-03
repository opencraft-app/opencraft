---
id: frontend-service-detail
type: service
scope: LightVela 双站 Web 前端的派生服务上下文。
triggers: ["frontend detail", "frontend architecture", "openspec"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - frontend/docs/README.md
  - frontend/catalog-info.yaml
  - frontend/AGENTS.md
  - frontend/openspec
status: active
reviewed_at: 2026-09-01
review_due: 2026-11-30
revision: 2.1.0
precedence: service
derived: true
related_packs: ["site-environment-routing", "identity-access", "subscription-entitlements"]
---

# Frontend 服务 Context

仅在命中 `frontend/`、双站 UI、产品文档或 OpenSpec 实现任务时加载；先读最近的 `frontend/AGENTS.md`。

## 当前边界

- 同一前端承载国内站与国际站；站点、鉴权、计费和实名的最终执行权在后端或网关，UI 不得成为唯一门禁。
- 产品文档真源为 `frontend/src/content/docs/`；不得直接编辑生成内容。
- 已归档的前端规格以 `frontend/openspec/` 为准。命中具体需求后才读取关联规格，不把整个 OpenSpec 注入默认 Context。

## 按需深入

- 服务职责、文档入口与验证边界：`frontend/docs/README.md`。
- 当前代码规则和最小命令：`frontend/AGENTS.md`。
- 双站、域名与 locale：`docs/context/domains/site-environment-routing.md`。
- 架构、模块关系或数据模型：`docs/context/project/overview.md` 后再按链接读取正式文档。

## 验证

在 `frontend/` 按改动运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 的最小有效组合；视觉或双站行为变更补聚焦截图/组件测试及 locale parity 证据。
