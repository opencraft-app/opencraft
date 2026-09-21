# NewAPI Web Agent 入口

本文件仅适用于 `new-api/web/`。它是简短指令入口；详细指引位于仓库根目录的 `docs/context/project/services/new-api-web.md`。

变更行为前：

1. 读取根 `AGENTS.md`，并以任务或触及路径运行仓库 context 路由器。
2. 工作变更 subtree 历史、导入上游或影响发布归属时，读取 `docs/context/project/upstream-subtrees.md`。
3. 确认 `package.json` 中的脚本和依赖；使用 Bun、React 19、TypeScript、Rsbuild、TanStack Router/Query、Zustand、Zod 和已有请求/UI abstraction。

硬约束：

- 所有用户可见文案必须走 i18n。
- 保留 typed API、route-search 和表单边界；不得引入 `any` 或平行请求层。
- 保留认证、错误、加载、空态、键盘和窄视口行为。
- 不得暴露 token、cookie、凭据或未净化的不可信 HTML。
- `new-api/` 是上游 subtree；源码导入不等于部署。

TypeScript/UI 变更的验证：

```bash
cd new-api/web
bun run typecheck
bun run lint
bun run format:check
bun run build:check
```

除以上静态门禁外，还要运行聚焦测试并检查变更状态的交互。
