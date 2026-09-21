# frontend

LightVela 的 Next.js（App Router）+ React 19 + TypeScript + Tailwind v4 前端。`vite.config.ts` / `src/vite-compat-main.ts` 仅为受信任基座测试保留的兼容 shell，不承载实际页面构建。

## 边界

- 最近的服务入口就是本文件；规划非简单变更前先读取路由到的 Domain Pack。
- 深层架构与流程细节延后至 [frontend 服务详情](../docs/context/project/services/frontend.md)。
- `frontend/openspec/` 下的 OpenSpec 是已归档前端规格的权威来源。

## UI 组件与样式约定（vibecoding 优先复用）

新增页面或改动 UI 时，先确认项目内是否已有可复用实现，避免引入新框架、新组件库或平行造轮子：

- 基础组件优先查 `src/components/ui/`（Radix UI primitives + `class-variance-authority` 变体 + `cn()`，shadcn 风格）：Button / Dialog / Popover / Select / Tabs / Card / Input / Label / Badge 等常见控件通常已存在。
- 业务级组件查 `src/components/site/`（站点级 header/footer/登录弹窗/语言切换等，目录内组件均为正在使用的稳定复用件）。
- 样式统一用 Tailwind v4 + `cn()`（`@/lib/utils` 的 `clsx` + `tailwind-merge`），不引入其他 CSS 方案；图标统一用 `lucide-react`。
- 路径引用用别名 `@/*`（→ `src/*`）/ `@next-site/*`，不写多级相对路径。
- 圆角、阴影、弹窗结构、下拉菜单、Tooltip 等可复用视觉/交互细节，目标规范见 [DESIGN.md](./DESIGN.md)（非现状快照，历史代码可能未完全对齐，勿以附近旧代码模式为参照）；新增可复用模式时补充该文档，而非在页面里各自定义一套。
- 确认已有组件无法满足需求，才新增组件；新增的可复用基础/业务组件应放入对应目录，不要内联在页面文件里。

## 命令

```bash
cd frontend
pnpm install
pnpm check      # i18n 提取/校验 + 繁简校验 + 文档同步校验 + typecheck-baseline
pnpm test
pnpm build
```

开发时运行最小有效子集，交接前运行 `check`/`test`/`build` 门禁。（`package.json` 未定义独立的 `lint` script，勿单独执行 `pnpm lint`。）

## 硬规则

- 不得新增 `any`；使用 `unknown` 或具体类型。
- 保留生成的 API 和 Domain contract 类型。
- 当后端或网关拥有执行权时，不得只在 UI 实现站点、计费或实名门禁。
- 视觉变更若可能回归行为或布局，须提供聚焦截图或组件测试。
