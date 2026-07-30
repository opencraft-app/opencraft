# 变更记录：Hermes Agent 版本升级公告

> 归档日期：2026-07-06
> 分支：`frontsandbox/hermes-agent-upgrade-announcement-0706`
> 变更类型：前端站点公告、国际站公告与窄屏体验优化
> 规模：S（single_agent）
> TAPD：
> MR：
> HEAD commit：`d03f5da9`
> 兼容说明：本次为小修直接执行，沿用当前仓库 `openspec/changes/YYYY-MM-DD-*.md` 扁平归档格式。

---

## 1. 需求概要

在 LightVela 国内站和国际站首页顶部增加 Hermes Agent 后台版本升级公告。国内站提示北京时间 2026-07-06 22:00 至 2026-07-07 02:00；国际站提示新加坡时间 2026-07-06 22:00 至 2026-07-07 02:00。升级期间智能体对话或任务执行可能短暂中止。国内站公告需要与已有转付费公告轮播展示，并保证 Hermes 版本升级公告处于第一位。

本轮同时修复窄屏下长公告文案可能被右侧按钮遮挡的问题。公告支持逐条关闭记忆和到期自动撤下；转付费公告继续只在国内站展示，避免国际站出现不相关轮播项。

## 2. 任务完成情况

2/2 个任务完成。

- [x] Developer: update the existing homepage announcement banner to support ordered carousel notices.
  - Files: `frontend/src/components/site/maintenance-announcement-banner.tsx`
  - Verify: Hermes upgrade notice appears first, paid announcement remains available as the next carousel item, and both keep dismiss / expiry behavior.
- [x] Reviewer: run focused frontend verification.
  - Commands: `pnpm i18n:extract`, `pnpm i18n:check`, `pnpm check`, `git diff --check`.

## 3. 关键决策

- 决策 1：复用现有 `MaintenanceAnnouncementBanner`，而不是新增一个升级公告组件。理由是既有组件已经承载首页路径白名单、国内站限定、文档流占位、关闭记忆和到期隐藏能力，复用能降低首页首屏回归风险。
- 决策 2：将单公告模型改为有序公告列表，列表顺序即轮播顺序。Hermes 升级公告 ID 固定排在第一位，转付费公告排在第二位，避免轮播初始化或筛选后出现顺序漂移。
- 决策 3：关闭状态按公告 ID 分别存储到 `localStorage`。这样用户关闭 Hermes 升级公告不会同时关闭转付费公告，后续发布新公告时也只需要替换 ID。
- 决策 4：窄屏下改为左对齐横向滚动，并为右侧关闭按钮保留固定安全区；桌面端保留居中和轮播控制按钮。这样长文案可以滚动完整阅读，且不会被右侧按钮遮挡。
- 决策 5：国际站只展示 Hermes 升级公告，并使用“新加坡时间”文案；转付费公告继续限定国内站。理由是用户明确要求国际站同步升级公告，但当前转付费公告仍属于国内站运营提示。

## 4. 实施摘要

### 代码变更

- `frontend/src/components/site/maintenance-announcement-banner.tsx`
  - 新增结构化公告列表，包含 Hermes 升级公告和转付费公告。
  - 国际站展示 Hermes 升级公告，文案使用新加坡时间；国内站展示 Hermes 升级公告和转付费公告轮播。
  - 新增公告过期时间、逐条关闭、自动轮播、上一条 / 下一条控制。
  - 保留首页文档流 36px 公告条，避免覆盖首页首屏。
  - 优化窄屏布局，使用横向滚动和按钮安全区避免文案遮挡。
- `frontend/src/i18n/generated/{zh-CN,en-US,zh-to-key}.json`
  - 补充北京时间 / 新加坡时间 Hermes 升级公告、上一条公告、下一条公告文案。
- `frontend/openspec/plan.md`
  - 记录本次实现与验证任务，归档后重置为占位语。

### 验证记录

- `npx --yes pnpm@10.32.1 install --frozen-lockfile`
  - 通过。
- `npx --yes pnpm@10.32.1 i18n:extract`
  - 通过，补充本次新增文案 key。
- `npx --yes pnpm@10.32.1 i18n:check`
  - 通过。
- `npx --yes pnpm@10.32.1 check`
  - 通过。
- `NEXT_PUBLIC_REGION=global VITE_REGION=global npx --yes pnpm@10.32.1 --dir frontend check`
  - 通过。
- `npx --yes pnpm@10.32.1 exec vitest related src/components/site/maintenance-announcement-banner.tsx --run --passWithNoTests`
  - 通过；当前组件无关联测试文件。
- `git diff --check`
  - 通过。
- 本地 CN 首页 `http://127.0.0.1:5174/`
  - 升级公告为第一条，下一条为转付费公告。
  - 390px 窄屏下滚动区域右边界早于关闭按钮左边界，文案无遮挡。
  - 浏览器 console error 数量为 0。

## 5. 规范沉淀

本次无 Delta Spec。该需求属于有明确过期时间的首页运营公告，不改变登录、订阅、Agent 控制台或业务 API 的能力模型；后续短期公告仍应优先复用 `MaintenanceAnnouncementBanner` 的结构化公告列表。

## 6. 回顾与改进

### 踩坑记录

- 坑 1：当前 master 已有转付费公告，但组件仍是单公告模型。直接替换文案会丢失转付费公告，因此需要先把公告抽成数组，并保留逐条关闭与过期隐藏。
- 坑 2：初版长公告在窄屏使用居中布局，文字溢出时会出现开头被裁切、末尾靠近关闭按钮的问题。根因是 `justify-center` 与横向 overflow 组合不适合长单行文案；解决方式是移动端左对齐滚动，桌面端再恢复居中。
- 坑 3：Next 16 本地启动不能沿用旧 Vite 启动直觉；本轮预览使用 `pnpm exec next dev -H 127.0.0.1 -p 5174` 成功启动。
- 坑 4：国际站默认英文，但本项目 i18n 仍以中文原文作为 key。新增国际站文案时需要写“新加坡时间”的中文源文案，并补齐 `en-US.json` 翻译，否则 `pnpm i18n:check` 会失败。

### 技术选型理由

- 未引入新依赖；继续使用 React state、定时器、现有 `localStorage` 关闭记忆和项目内 `cn` 工具函数。
- 轮播控制使用已有 lucide 图标，符合站点当前图标来源和按钮交互习惯。
- i18n 继续通过 `pnpm i18n:extract` 生成，避免手工维护 hash key。

### 可复用经验

- 多条站点公告应显式建模为有序列表，而不是在 JSX 中拼多个条件分支；顺序、过期、关闭状态都能集中处理。
- 区域化公告应同时考虑“公告是否展示”和“同一公告在不同区域的时间口径文案”，避免直接复用国内时间描述。
- 临时公告必须给每条公告独立 ID，避免用户关闭旧公告后影响新公告展示。
- 顶部公告在移动端承载长文本时，应优先保证完整可读和操作按钮不遮挡，必要时接受横向滚动。

### 未实现 / 后续优化

- 本次未引入远程公告配置中心。若后续公告发布频率升高，可考虑把公告内容、排序、可见路径、过期时间抽为结构化配置。
- 本次未补充组件单测。后续若公告条继续增加规则，可为可见公告筛选和轮播索引补纯逻辑测试。
