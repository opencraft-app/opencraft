# 变更记录：Hermes Agent 版本更新公告

> **日期：** 2026-06-17
> **分支：** `frontsandbox/hermes-agent-version-announcement`
> **规模：** S（single_agent）
> **TAPD：**
> **MR：**
> **HEAD commit：** `274e5612`
> **兼容说明：** 本次为小修直接执行，`current_state.md` 没有 v0.33 的「当前进行中」段，已按用户确认 `[c]` 兼容归档。

---

## 一、需求概要

在 LightVela 国内站首页顶部增加 Hermes Agent 版本更新公告，提醒用户北京时间 2026-06-17 21:00-次日 05:30 将进行后台版本升级，升级期间智能体对话或任务执行可能短暂中止。公告使用已有顶部公告组件，保持关闭记忆和到期自动隐藏能力。

## 二、任务完成情况

1/1 个任务完成。

- [x] Developer: update the existing maintenance announcement banner for the new Hermes Agent version upgrade notice.
  - Files: `frontend/src/components/site/maintenance-announcement-banner.tsx`
  - Verify: `pnpm i18n:extract`, `pnpm i18n:check`, `pnpm check`, `git diff --check`.

## 三、关键决策

- 决策 1：复用已有 `MaintenanceAnnouncementBanner`，而不是新增一套站点公告组件。理由是既有组件已具备路径白名单、关闭记忆、过期隐藏和 i18n 接入，复用可以把改动限制在公告数据和布局行为上。
- 决策 2：将公告从 `fixed top-0` 改为普通文档流顶部条。原因是首页当前使用 Figma 导入的 Header/Hero 结构，不完全消费旧的 `body.lw-has-announcement` 补偿逻辑，fixed 公告会压住首屏内容；文档流方案让公告与首页天然上下排列。
- 决策 3：删除 `body.lw-has-announcement` 的动态 class 与 CSS 补偿分支。公告不再脱离文档流后，继续保留补偿逻辑会增加未来 header/hero 的理解成本，也可能让其它 fixed 顶栏产生不必要偏移。
- 技术选型理由：未引入新依赖；继续使用 React state、`localStorage` 和现有 i18n 抽取机制，符合当前前端项目的轻量模式。

## 四、实施摘要

- 文件改动：6 个，+28/-104。
- 主要文件：
  - `frontend/src/components/site/maintenance-announcement-banner.tsx`
  - `frontend/src/styles.css`
  - `frontend/src/i18n/generated/{zh-CN,en-US,zh-to-key}.json`
  - `frontend/openspec/plan.md`
- 关键 commits：当前分支尚未产生业务提交，基线 HEAD 为 `274e5612 Retrigger CloudLadder callback routing release`。
- 验证结果：
  - `npx --yes pnpm@10.32.1 install --frozen-lockfile`
  - `npx --yes pnpm@10.32.1 i18n:extract`
  - `npx --yes pnpm@10.32.1 i18n:check`
  - `npx --yes pnpm@10.32.1 check`
  - `git diff --check`
  - 本地 CN 预览 `http://127.0.0.1:5174/`：公告 `position: relative`，首页根容器、Header、Hero 从 `top=36` 开始，不再 z 轴覆盖。

## 五、规范沉淀

本次无 Delta Spec。该公告属于站点运营提示的小修，不改变现有业务能力模型；后续类似临时公告仍应优先复用 `MaintenanceAnnouncementBanner`，避免散落多个公告入口。

## 六、回顾与改进

### 踩坑记录

- 坑 1：仅更新公告文案和过期时间后，首页截图显示公告覆盖首屏内容。根因是公告仍为 `fixed top-0`，旧的 body class 补偿没有覆盖当前 Figma 导入首页结构。解决方式是将公告改为文档流顶部条，并清理旧补偿逻辑。
- 坑 2：`pnpm i18n:extract` 会同步清理已经不再被源码引用的旧 key，不只是新增本次公告 key。处理方式是保留脚本生成结果，并通过 `pnpm i18n:check` 验证生成文件自洽。

### 可复用经验

- 临时公告若只在首页展示，使用路径白名单和公告 ID 版本化即可；新公告更新 `ANNOUNCEMENT_ID`，避免用户上次关闭状态影响本次公告。
- 顶部公告涉及首页首屏时，优先选择文档流占位；只有确实需要跨页面固定悬浮时，再引入 fixed 和页面级补偿。
- 前端本地校验使用 CI pin 的 `pnpm@10.32.1`，避免本地 pnpm 9 与 CI 行为不一致。

### 未实现 / 后续优化

- 本次需求未引入通用公告配置中心。若后续频繁发布运营公告，可考虑把公告内容、可见路径、过期时间抽到结构化配置，降低每次改组件源码的成本。
