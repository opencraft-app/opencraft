---
id: domestic-featured-skill-additions-2026-09-18
type: task
scope: 国内站 Skills 顶部精选新增三张 SkillHub 卡
owner: codex
authority: primary
source_of_truth:
  - frontend/src/pages/marketing/skills-demo/domestic-skill-catalog.ts
  - frontend/src/pages/marketing/skills-demo/curated-skill-overviews.zh.ts
status: complete
reviewed_at: 2026-09-18
review_due: 2026-12-17
revision: 1.0.0
precedence: task
derived: false
---

## goal

将 `Suno歌词成曲`、`防诈专家`、`中文公文写作` 追加到国内站 Skills 顶部精选的最后一页。

为三张卡补齐经过 SkillHub 核对的身份、图标、下载量快照、中文详情和独立横幅资源。

## non_goals

- 不改国际站 Skills 页面。
- 不移除或重排现有国内站顶部精选卡。
- 不提交、推送、创建 MR 或发布。

## requirement_refs

- `https://skillhub.cn/skills/user_87b8e34f/suno-lyrics-to-song`
- `https://skillhub.cn/skills/indiv-skill/anti-fraud`
- `https://skillhub.cn/skills/user_f3d82da7/chinese-official-writing`

## interface_refs / data_structure_refs

- `DOMESTIC_FEATURED_SKILLS` 为国内站顶部精选的人工配置真源。
- `FEATURED_BATCH_SIZE = 3`，新增三张应形成第三页。
- `CURATED_SKILL_OVERVIEWS_ZH` 为中文详情弹窗真源。

## acceptance

- 三张指定 SkillHub 卡追加到国内站顶部精选末尾。
- 每张卡保留 SkillHub slug、图标 URL、下载量快照和唯一横幅资源。
- 三张卡均有完整中文详情模板和安装身份。
- 新增后顶部精选共 9 张、每页 3 张，第三页为三张新增卡。
- 运行定向测试、TypeScript 检查和 `git diff --check`。

## affected_paths

- `frontend/src/pages/marketing/skills-demo/domestic-skill-catalog.ts`
- `frontend/src/pages/marketing/skills-demo/domestic-skill-catalog.test.ts`
- `frontend/src/pages/marketing/skills-demo/curated-skill-overviews.zh.ts`
- `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- `frontend/public/assets/skills/featured-*.jpg`

## required_context

- `site-environment-routing`
- `frontend/AGENTS.md`
- `.agents/skills/product-skills/lv-sitepage-skills/SKILL.md`
- `/Users/cassidyshi/.codex/skills/.system/imagegen/SKILL.md`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md` | 确认国内站独立边界 | 仅更新 domestic Featured |
| `frontend/AGENTS.md` | 前端实现和验证约束 | 复用现有组件并完成定向检查 |
| `.agents/skills/product-skills/lv-sitepage-skills/SKILL.md` | Featured 运营规范 | 追加三张卡、完整详情和独立横幅 |
| `/Users/cassidyshi/.codex/skills/.system/imagegen/SKILL.md` | 横幅生成流程 | 使用内置图像生成并把资产放入项目 |
| `.agents/skills/product-skills/lv-sitepage-skills/references/featured-banner-reference.png` | 横幅构图参考 | 保留左侧文字留白与右侧 3D 主体布局 |

## evidence

- 已从 SkillHub API 精确核对用户提供的三条页面：
  - `user_87b8e34f/suno-lyrics-to-song`，下载量 `103205`，使用其 PNG 图标。
  - `indiv-skill/anti-fraud`，下载量 `125898`，使用其 PNG 图标。
  - `user_f3d82da7/chinese-official-writing`，下载量 `149071`，使用其 PNG 图标。
- 三张横幅均为本次生成的 1200×576 JPEG，构图保持左侧文案留白、右侧无文字的 3D 主体。

## risks

- `anti-fraud` 存在同 slug 条目，必须按用户提供的 `indiv-skill` 页面精确选择。
- 横幅为独立生成资源，需避免图片内文字、Logo 和水印。

## validation

- `cd frontend && pnpm i18n:check` 通过。
- `cd frontend && pnpm i18n:validate` 通过，无错误，保留仓库既有 51 条告警。
- `cd frontend && pnpm i18n:zh-hant --check` 通过。
- `cd frontend && ./node_modules/.bin/vitest run src/pages/marketing/skills-demo/domestic-skill-catalog.test.ts` 通过，6 个测试通过。
- `cd frontend && ./node_modules/.bin/tsc --noEmit --pretty false` 通过。
- `cd frontend && pnpm check` 通过。
- `git diff --check` 通过。
- 已检查三张横幅配置路径存在，并确认为 1200×576 JPEG。

## decisions

- 按用户要求追加到最后一页，因此不改变现有六张卡的次序。

## scan_scope

- `frontend/src/pages/marketing/skills-demo/`
- `frontend/public/assets/skills/`

## scan_output

- `DOMESTIC_FEATURED_SKILLS` 由前三页共 9 张卡组成，新增条目位于末尾三张。
- `FEATURED_BATCH_SIZE = 3`，末页恰为 Suno歌词成曲、防诈专家、中文公文写作。
- `anti-fraud` 在已有分类卡中存在同一安装 slug；新 Featured 项使用独立展示 `id` `anti-fraud-expert`，但保留用户指定 SkillHub 页面对应的 `anti-fraud` 安装身份。

## handoff

- 当前状态：完成，未提交、推送、创建 MR 或发布。
- 阻塞项：无。
