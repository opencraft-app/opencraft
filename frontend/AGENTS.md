# frontend

LightVela 的 Next.js（App Router）+ React 19 + TypeScript + Tailwind v4 前端。`vite.config.ts` / `src/vite-compat-main.ts` 仅为受信任基座测试保留的兼容 shell，不承载实际页面构建。

## 边界

- 最近的服务入口就是本文件；规划非简单变更前先读取路由到的 Domain Pack。
- 深层架构与流程细节延后至 [frontend 服务详情](../docs/context/project/services/frontend.md)。
- `frontend/openspec/` 下的 OpenSpec 是已归档前端规格的权威来源。
- 修改前端视觉样式时先读 [DESIGN.md](DESIGN.md)。

## UI 组件与样式约定（vibecoding 优先复用）

新增页面或改动 UI 时，先确认项目内是否已有可复用实现，避免引入新框架、新组件库或平行造轮子：

- 基础组件优先查 `src/components/ui/`（Radix UI primitives + `class-variance-authority` 变体 + `cn()`，shadcn 风格）：Button / Dialog / Popover / Select / Tabs / Card / Input / Label / Badge 等常见控件通常已存在。
- 业务级组件查 `src/components/site/`（站点级 header/footer/登录弹窗/语言切换等，目录内组件均为正在使用的稳定复用件）。
- 样式统一用 Tailwind v4 + `cn()`（`@/lib/utils` 的 `clsx` + `tailwind-merge`），不引入其他 CSS 方案；图标统一用 `lucide-react`。
- 路径引用用别名 `@/*`（→ `src/*`）/ `@next-site/*`，不写多级相对路径。
- 圆角、阴影、弹窗结构、下拉菜单、Tooltip 等可复用视觉/交互细节，目标规范见 [DESIGN.md](./DESIGN.md)（非现状快照，历史代码可能未完全对齐，勿以附近旧代码模式为参照）；新增可复用模式时补充该文档，而非在页面里各自定义一套。
- 确认已有组件无法满足需求，才新增组件；新增的可复用基础/业务组件应放入对应目录，不要内联在页面文件里。

## 图片资产约定（vibecoding 新增/替换图片前必读）

新增或替换页面/文档/博客位图（截图、插画、封面等）时，**默认必须用 `.webp`，不要新增 `.png`/`.jpg`**：

- **为什么**：png/jpg 在 `next build` 与 gzip 后收益极小，是首屏与仓库体积膨胀的主因；同一张图转 webp 通常再省 70%~95% 且肉眼无损。历史 png 已批量治理为 webp，勿再引入新 png 让其退化。
- **开发时先确认**：动手加图前，先问自己「这张图能不能直接产出 webp？」——能就直接以 webp 落盘并在代码/MDX 中引用 `.webp`。仅当确有透明+无损或逐帧动画等 webp 无法满足的硬需求时，才保留 png/gif，并在 PR 描述里说明原因。
- **资产清理/压缩**：`scripts/optimize-source-assets.mjs` 负责删孤儿图 + 对存量 png/jpg 做**无损压缩**（保持原格式，不转 webp）。清理无用资产时先 dry-run 再 `--apply`：
  ```bash
  cd frontend
  node scripts/optimize-source-assets.mjs                    # dry-run，先看报告
  node scripts/optimize-source-assets.mjs --apply            # 无损压缩存量 png/jpg
  node scripts/optimize-source-assets.mjs --apply --delete-unused  # 附带删除孤儿图
  ```
- **png→webp 格式转换**：该脚本不做格式转换。存量 png 转 webp 是破坏性且需同步改引用的变更，须显式处理：用 sharp 生成同名 `.webp`（`sharp(src).webp({ quality: 82 })`），删除原 png，再全量搜索旧文件名（含 `src/imports/*/assets.ts`、MDX、CSS）改为 `.webp` 引用，避免死链。转换后务必跑 `pnpm check`/`pnpm build` 复核无死链。

## 命令

```bash
cd frontend
pnpm install
pnpm check      # i18n 提取/校验 + 繁简校验 + 文档同步校验 + typecheck-baseline
pnpm test
pnpm build
```

开发时运行最小有效子集，交接前运行 `check`/`test`/`build` 门禁。（`package.json` 未定义独立的 `lint` script，勿单独执行 `pnpm lint`。）

## OpenCraft Agent Console 同步门禁

修改 `frontend/src/` 或 `frontend/public/` 后，提交 MR 前须在仓库根运行只读检查 `npm --prefix opencraft run check:mono2-agent-console`；前端的 `pnpm check` 和构建不能替代它。若检查报告生成副本漂移，先提交 frontend 真源（同步清单的 `sourceRevision` 取自 Git 历史），再运行 `npm --prefix opencraft run sync:mono2-agent-console`，将脚本生成的副本及 `UPSTREAM.json` 作为独立的后续提交，并重新运行只读检查。同步范围以 `opencraft/scripts/sync-mono2-agent-console.mjs` 为准，不手工编辑生成副本或清单。

## 硬规则

- 不得新增 `any`；使用 `unknown` 或具体类型。
- 保留生成的 API 和 Domain contract 类型。
- 当后端或网关拥有执行权时，不得只在 UI 实现站点、计费或实名门禁。
- 视觉变更若可能回归行为或布局，须提供聚焦截图或组件测试。
- 新增位图资产默认用 `.webp`，不得随意新增 `.png`/`.jpg`；确有 webp 无法满足的硬需求（如透明无损、逐帧动画）才例外，并在 PR 说明原因。
