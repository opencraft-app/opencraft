# frontend

LightVela 的 React 19 + TypeScript + Vite + Tailwind 前端。

## 边界

- 最近的服务入口就是本文件；规划非简单变更前先读取路由到的 Domain Pack。
- 深层架构与流程细节延后至 [frontend 服务详情](../docs/context/project/services/frontend.md)。
- `frontend/openspec/` 下的 OpenSpec 是已归档前端规格的权威来源。

## 命令

```bash
cd frontend
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

开发时运行最小有效子集，交接前运行要求的 lint/type/test/build 门禁。

## 硬规则

- 不得新增 `any`；使用 `unknown` 或具体类型。
- 保留生成的 API 和 Domain contract 类型。
- 当后端或网关拥有执行权时，不得只在 UI 实现站点、计费或实名门禁。
- 视觉变更若可能回归行为或布局，须提供聚焦截图或组件测试。
