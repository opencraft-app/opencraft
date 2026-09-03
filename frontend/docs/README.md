# LightVela Web 前端

`frontend` 同时承载国内站 `lightvela.com`、国际站 `lightvela.ai` 的产品页面和客户文档；站点差异必须由共享路由 contract 与后端执行边界共同约束。

## 权威入口

- [开发说明](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- 产品文档源：`../src/content/docs/`
- [站点与环境领域](../../docs/engineering/domains/site-environment-routing.md)

## 关键边界

不新增 `any`，不绕过生成的 API/Domain 类型。当鉴权、计费或实名规则由后端/网关拥有时，前端只负责表达状态，不能成为唯一门禁。产品文档保留 cn/global/en/id 真源，不直接编辑 `.fumadocs-content`。

## 验证

```bash
cd frontend
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

视觉或双站行为变更还需聚焦截图/组件测试与对应 locale parity 证据。
