# OpenCraft Agent 入口

本入口适用于 `opencraft/`。先读取仓库根 `AGENTS.md` 并路由任务，再按需读取：

- 维护总纲：[opencraft-maintenance](.agents/skills/opencraft-maintenance/SKILL.md)。维护 OpenCraft 的架构、交互、布局动画、平台适配或桌面预览时使用；其中的验证清单按本次边界加载，正式架构文档仍是事实真源。
- 平台、AppServer、Chat Runtime、Workbench 或扩展架构：`opencraft/docs/platform-architecture.md` 与对应专题文档。
- 任务工作区呈现、工具面板/浮动聊天/Side Chat：`opencraft/design/README.md`；实现变更同步维护 `design/invariants.md` 的责任与证据。
- mono2 Agent Console 共享实现：`opencraft/MONO2_MIGRATION.md`、`frontend/AGENTS.md`；修改同步边界时同时读取 `docs/context/project/upstream-subtrees.md`。
- Web、Expo、Electron 的构建与发布矩阵：`opencraft/docs/build-matrix.md`。

硬约束：

- `opencraft/` 是独立 npm workspace 根，保留自己的 `package-lock.json`；不得与 `frontend/` 的 pnpm workspace 或锁文件合并。
- mono2 是 OpenCraft 的唯一写入真源。旧 `wisp/opencraft` 仓库仅保留为迁移历史和回退证据，不建立双向 subtree 同步。
- `plugins/lightvela-hermes/src/upstream/mono2/` 是机械生成的过渡层。不得直接编辑；修改 `frontend/` 上游后运行 `npm run sync:mono2-agent-console`，并提交生成清单。
- OpenCraft 的校验或构建不得隐式触发 frontend、GitOps 或生产发布。
- 变更后至少运行受影响的聚焦测试；跨包、共享前端或发布矩阵变更运行 `npm run gate`。

构建产物、`node_modules`、本地日志和机器路径不得进入 Git。
