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

### Typography 所有权

- `packages/design-system/src/typography/typography.tokens.json` 是字体栈、平台度量和语义 Typography Role 的唯一数据真源。`typography.shared.ts` 是 TypeScript/Native 投影，`_generated.web.scss` 是生成的 Web 变量；不得直接编辑 `_generated.web.scss`，修改后运行 `npm run generate:typography` 与 `npm run check:typography`。
- 文件拓扑固定为 `registry → platform adapter → typography primitive → Shell/feature consumer`。业务组件不得反向导入生成脚本、读取 JSON、自建平行 role registry，或在页面 CSS 中复制一套 Sidebar/Toolbar 字体比例。
- FontFamily、TypographyRole、TextTone 和平台渲染策略是四个正交所有者。低层 TypographyRole 只包含 family role、字号、行高与规范字重；颜色由 TextTone 组合，`font-smoothing` 等由平台 rendering policy 持有，禁止把 hover/selected/disabled 颜色复制成新的字体角色。
- Shell、Sidebar、Settings 导航和平台扩展 Chrome 优先消费 `typography.web.scss` 的语义 mixin。新增或修改这些区域时，不得直接写 `font-family`、`font-size`、`line-height`、`font-weight`；确有新层级先扩展 registry。内容排版、代码和第三方嵌入有独立责任边界，不得为了统一而机械迁移。
- 只允许 `400/500/600/700` 规范字重；禁止 `520/550` 等任意权重进入新代码。除上游明确设计证据外不新增或局部修改 letter-spacing。主要导航与会话身份使用 primary TextTone，secondary/tertiary 仅用于说明、元数据和弱化状态，不能靠整体灰化制造层级。
- Web/Electron UI stack 采用 system-first 的统一 fallback；Native 使用平台 system face。统一指 role 与 fallback 所有权一致，不要求跨平台物理字形相同。字体改动必须在真实 Electron 上记录 computed family/size/line-height/weight/tone/smoothing，并同时检查中英文、浅深主题和无布局位移。

构建产物、`node_modules`、本地日志和机器路径不得进入 Git。
