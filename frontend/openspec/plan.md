# 2026-08-11 国际站首页默认英文一致性修复

**Status:** 实现中；确认前不 commit / push / MR。

**Goal:** `lightvela.ai/` 裸首页在浏览器残留中文语言偏好时仍默认全页英文，只有访问中文 locale 路径或用户显式切换中文时展示中文。

**Scope:** 仅收敛公开首页 locale 判定、公告条 locale 注入、首页导入区翻译调用和回归测试；不改视觉布局、路由 SEO 输出、后端接口或订阅/登录逻辑。

## Tasks

- [x] 修复国际站裸 `/` 的 i18n 初始语言，避免被 `localStorage.lw-locale=zh-CN` 覆盖。
- [x] 修复首页公告条与 FeatureSection 对全局 i18n 单例的依赖，统一跟随公开路由 locale。
- [x] 补充回归测试并运行定向测试、i18n 检查、类型检查和 diff 检查。

---

# 国际站 Skills 搜索结果来源链接 Implementation Plan

**Status:** 实现与验证完成，等待用户验收；不自动提交、推送或创建 MR。

**Goal:** 国际站所有 Skills 搜索结果都在技能标题和 slug 下方单独展示文字型 `Source` 链接；ClawHub 统一链接到 `https://clawhub.ai/`。

**Architecture:** `SearchSkillRow` 继续使用 skills.sh 的技能详情链接，但对 ClawHub 直接使用固定官网地址。
链接只由前端渲染，不查询 ClawHub 作者或技能详情，因此不会新增 ClawHub 请求或增加限流风险。

**Tech Stack:** React 19、TypeScript 5.9、Tailwind CSS、Vitest 4、React Testing Library。

## Global Constraints

- 仅影响国际站的 ClawHub 与 skills.sh 搜索结果。
- 国内 SkillHub 搜索结果不展示新来源行。
- 所有 ClawHub 搜索结果都显示来源链接，固定 URL 为 `https://clawhub.ai/`。
- 标签通过现有 i18n `t("来源")` 渲染，样式与 skills.sh 的文字型来源链接一致。
- 不新增依赖、动画或新的交互原语。

## Tasks

- [x] **Task 1: 固定 ClawHub 搜索结果来源链接。**
  - 修改 `src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`，先断言 ClawHub 搜索结果的 `来源` 链接固定为 `https://clawhub.ai/`。
  - 修改 `src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`，仅在 global mode 的 `SearchSkillRow` 中为 ClawHub 使用固定官网链接，skills.sh 与国内站逻辑保持不变。
  - 运行 `pnpm exec vitest run src/pages/marketing/skills-demo/skill-registries.test.ts src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`。

- [x] **Task 2: 运行质量门禁并记录验证。**
  - 运行 `pnpm i18n:check`。
  - 运行 `pnpm check`。
  - 检查 `git diff --check` 与最终 diff，确认未修改国内站分支逻辑。

---
# Agents 左侧导航顺序调整 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** 实现与验证完成，用户已确认提交、推送与创建 MR。

**Goal:** 将 `/agents` 左侧导航中的“自动任务”移动到“人设”上方，并保持其余导航行为不变。

**Architecture:** 沿用 `AgentSettingsPage` 内现有 `settingsSections` 数组作为唯一顺序来源，只交换两个相邻配置项。用独立静态回归测试锁定两项顺序，避免为了单一展示顺序抽离新公共接口。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4。

## Global Constraints

- 仅修改导航顺序及其回归测试，不修改路由、图标、文案、权限或页面内容。
- 桌面和移动端继续共用同一导航配置。
- 不新增依赖或配置抽象。

## Tasks

- [x] **Task 1 — Developer / Reviewer：交换导航项并验证**
  - **Files:**
    - Create: `frontend/src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`
    - Modify: `frontend/src/pages/marketing/agent-settings-page.tsx:4909-4915`
  - **Interfaces:** 不新增导出；测试只读取页面源码中的 `settingsSections` 配置片段。
  - **Step 1 — 写失败测试：** 新测试读取 `agent-settings-page.tsx`，截取 `const settingsSections` 到 `const isRestartDisabled` 之间的文本，并断言 `id: "automations"` 的索引小于 `id: "buddy"`：

    ```ts
    import { readFileSync } from "node:fs";
    import { join } from "node:path";
    import { describe, expect, it } from "vitest";

    describe("Agent settings navigation order", () => {
      it("places automations before persona", () => {
        const page = readFileSync(
          join(process.cwd(), "src/pages/marketing/agent-settings-page.tsx"),
          "utf8",
        );
        const settingsSectionsStart = page.indexOf("const settingsSections");
        const settingsSectionsEnd = page.indexOf("const isRestartDisabled");

        expect(settingsSectionsStart).toBeGreaterThanOrEqual(0);
        expect(settingsSectionsEnd).toBeGreaterThan(settingsSectionsStart);

        const settingsSections = page.slice(settingsSectionsStart, settingsSectionsEnd);
        const automationsIndex = settingsSections.indexOf('id: "automations"');
        const personaIndex = settingsSections.indexOf('id: "buddy"');

        expect(automationsIndex).toBeGreaterThanOrEqual(0);
        expect(personaIndex).toBeGreaterThanOrEqual(0);
        expect(automationsIndex).toBeLessThan(personaIndex);
      });
    });
    ```
  - **Step 2 — 确认 RED：** 在 `frontend/` 运行 `pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`；预期当前顺序下断言失败。
  - **Step 3 — 最小实现：** 在 `settingsSections` 中把完整的 `automations` 配置项移动到完整的 `buddy` 配置项之前，不改动两项内容：

    ```tsx
    { id: "automations", label: t("自动任务"), icon: <CalendarClock className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.automations },
    { id: "buddy" as const, label: t("人设"), icon: <UserRound className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.buddy },
    ```
  - **Step 4 — 确认 GREEN：** 重新运行同一定向 Vitest，预期 1 个测试通过。
  - **Step 5 — 完整验证：** 在 `frontend/` 运行 `pnpm check`，再在仓库根运行 `git diff --check`；检查 diff 仅包含计划、测试和两项顺序调整。
  - **Step 6 — 验收门禁：** 展示改动与验证结果，等待用户确认后才允许提交实现、推送或创建 MR。

---

# 2026-08-07 批量安装汇总结果对齐修复

**Status:** 实现与验证完成；等待用户确认后再 commit / push / MR。

**Goal:** ACLI 同时返回逐项 `progress` 和完整 `summary.results` 时，避免重复汇总结果错配到下一个未完成技能，确保部分失败状态准确展示。

**Scope:** 仅修正 Skills 批量安装结果匹配逻辑并补回归测试；不改变 ACLI 命令、SSE 协议、取消粒度或页面交互。

## Tasks

- [x] 增加“progress 后返回完整 summary.results”的失败回归测试并确认 RED。
- [x] 修正已完成结果的去重与无标识结果的顺序降级逻辑。
- [x] 运行 Skills 定向测试、类型检查、i18n 检查和 diff 检查。

---

# 2026-08-09 EdgeOne Pages 裸根路径 404 修复

**Status:** 实现与 Preview 验证完成，用户已确认提交、推送并创建 MR。

**Goal:** 让 EdgeOne Pages 的裸根路径 `/` 直接由 Build Output 的 filesystem 路由提供静态首页，避免显式重写 `/index.html` 触发 Pages 路由缓存分裂和概率性平台 404。

**Scope:** 仅调整 EdgeOne Build Output 路由生成及其回归测试；不修改页面运行时代码、外层加速域名配置或生产发布配置。

## Tasks

- [x] 先补充失败测试，禁止生成 `^/$ -> /index.html` 显式根路由。
- [x] 删除显式根路由，保留 filesystem 与普通目录 HTML fallback 的顺序。
- [x] 运行定向测试、frontend 检查并验证生成配置。
- [x] 发布 Preview，连续验证不带查询参数的裸 `/`。
- [x] 用户确认后提交、推送并创建 MR。

## Verification

- `pnpm exec vitest run scripts/fix-next-static-html-lang.test.ts`
- `pnpm check`
- `git diff --check`

---

# 2026-08-07 国际站 Skills 来源说明对齐国内站

**Status:** 实现与验证完成，等待用户手动验收；不自动 commit / push / MR。

**Goal:** 将国际站搜索来源说明从搜索栏移到搜索结果底部，复用国内站“查看更多居中、来源说明靠右”的蓝色布局，并恢复搜索框宽度及来源筛选器右对齐。

**Scope:** 仅调整国际站 Skills 搜索区域布局和对应组件测试；保留 Skills.sh、ClawHub 链接、搜索过滤与展开逻辑，不改变国内站行为。

## Tasks

- [x] **Developer / Test:** 修改 `src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`，断言国际站搜索栏不再包含来源说明、结果底栏展示蓝色 Skills.sh 与 ClawHub 链接，并确认测试按预期失败。
- [x] **Developer / UI:** 修改 `src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`，复用国内站三列结果底栏，删除搜索栏旧说明；验收时搜索框占满剩余宽度、来源筛选器靠右。
- [x] **Reviewer / Verification:** 运行 Skills 定向测试、`pnpm i18n:check`、`pnpm check` 和 `git diff --check`，确认国内站布局断言保持通过且无新增依赖或生成资源。

---

# 2026-08-07 国际站合并技能卸载降级

**Status:** 实现与验证完成，等待用户验收；不自动 commit / push / MR。

**Goal:** 删除同时标记为 ClawHub 与 skills.sh 的单个运行时技能时，不重复执行两个卸载命令导致 `SKILLS_SH_NOT_INSTALLED`。

**Scope:** 合并行的来源标识作为候选卸载命令；任一候选成功后停止，明确未安装时尝试下一候选，其他错误继续正常失败。

## Tasks

- [x] 增加“首个来源成功即停止”和“首个来源未安装则降级”的失败回归测试。
- [x] 调整国际站卸载候选执行与错误处理逻辑。
- [x] 运行 Skills 定向测试、i18n、类型检查和 diff 检查。

---

# 2026-08-07 国际站已安装技能跨来源去重

**Status:** 实现与验证完成，等待用户验收；不自动 commit / push / MR。

**Goal:** 国际站同一 Hermes 运行时技能同时出现在 ClawHub 与 skills.sh 已安装清单时，仅展示一行，并同时展示两个来源标签。

**Scope:** 仅调整国际站已安装技能归并逻辑与回归测试；保留各 registry 的真实卸载目标，不按短 slug 盲目合并无 Hermes 证据的记录。

## Tasks

- [x] 增加跨来源重复安装记录的回归测试，并确认当前实现失败。
- [x] 以 Hermes 运行时记录为归并证据，合并 ClawHub 与 skills.sh 展示记录并保留双来源卸载目标。
- [x] 运行定向测试、类型检查和 diff 检查。

---

# 2026-08-06 前端预览图片体积优化

**Status:** 实现与验证完成，等待用户验收；不自动 commit / push / MR。

**Goal:** 将分支预览压缩包从约 60 MiB 降到 45-50 MiB，避免接近 StaticPages 上传链路的疑似 64 MiB 边界。

**Scope:** 仅优化文档中超过 512 KiB 的 PNG/JPEG 源图及其 Markdown 引用，并增加资源体积回归测试；不调整页面布局、搜索、视频或生产发布逻辑。

## Tasks

- [x] 增加文档大图格式与体积回归测试，并确认现有资源会触发失败。
- [x] 将超预算文档图片转换为 WebP，更新中英文 Markdown 引用和公开资源副本。
- [x] 运行定向测试、类型检查和 global 预览构建，核验压缩包体积为 43.50 MiB。

---

# 2026-08-04 QQ Bot 群聊策略自动开启

**Status:** 实现与验证完成，待用户验收；确认前不 commit / push / MR。

**Goal:** 在 LightVela 通道配置 SDK 的 QQ 卡片中，用户通过扫码或 AppID / Secret 绑定 QQ Bot 时，自动在同一次 debug/exec 命令里先执行 `hermes config set platforms.qqbot.extra.group_policy open`，再执行 SDK 原始 QQ 绑定命令，避免额外触发第二次 gateway restart。

**Scope:** 仅修改前端 SDK debug/exec 适配链路、QQ group policy helper、相关单测和 QQ 通道文档；不修改 SDK 包版本、不修改后端接口、不提交远端代码。

## Tasks

- [x] 新增 QQ group policy 命令识别与包装 helper，覆盖 AppID / Secret 与扫码两条 QQ 绑定命令。
- [x] 扩展 debug/exec lifecycle 支持 `transformCommand`，并提供 lifecycle 组合 helper，保证模型切换自动任务同步不被覆盖。
- [x] 在 `/agents` 设置页接入 QQ lifecycle，使 SDK QQ 配置卡片下发命令前完成 group_policy 注入。
- [x] 更新 QQ 通道中英文文档，说明绑定后默认开启群聊 @ 对话及 `open` 权限边界。
- [x] 运行相关 Vitest、类型检查和 diff 检查，停在用户验收确认点。

## Verification

- `pnpm exec vitest run src/pages/marketing/__tests__/agent-qqbot-group-policy.test.ts src/pages/marketing/__tests__/agent-debug-exec-lifecycle.test.ts src/pages/marketing/__tests__/agent-tat-adapter.test.ts src/pages/marketing/__tests__/agent-settings-sdk-boundary.test.ts`
- `pnpm check`
- `git diff --check`

---

# 2026-07-31 Hermes 版本升级公告

**Status:** 前端实现完成，待用户验收后再提交 / MR；关联 Vitest 受当前 jsdom 依赖链阻塞。

**Goal:** 基于最新 `master` 在首页公告条挂今晚 Hermes 版本升级提醒，国内站与国际站均展示对应时区文案。

**Scope:** 仅更新首页公告条、对应中英文 i18n 字典和本计划；不调整公告视觉结构、路由、登录态、后端接口或其他公告轮播逻辑。

## Tasks

- [x] 将 Hermes 升级公告切换到 2026-07-31 22:00 至 2026-08-01 02:00。
  - 国内站文案使用北京时间。
  - 国际站文案使用新加坡时间。
  - 公告 ID 更新，避免复用上一次关闭记忆。
  - 过期时间为 UTC 2026-07-31 18:00。
- [x] 更新 i18n 生成字典并补齐英文翻译。
- [x] 完成基础验证：`pnpm i18n:check`、`pnpm check`、global 环境 `pnpm check`、`git diff --check`、公告静态 smoke。
- [ ] 关联 Vitest 复跑：当前 `vitest related src/components/site/maintenance-announcement-banner.tsx` 被 `jsdom@28.1.0 -> html-encoding-sniffer@6.0.0 -> @exodus/bytes` 的 `ERR_REQUIRE_ESM` 阻塞，未进入业务断言。

---

# 国内站登录弹窗交互优化 Implementation Plan

**Status:** 前端实现已完成，待用户验收后再提交 / MR / 归档。

**Goal:** 国内站登录弹窗默认微信登录，手机号与 QQ 作为底部其他登录方式；手机号登录成为正式入口；不引入后端改动。

## Constraints

- 仅国内站生效，国际站登录方式保持不变。
- 不新增后端接口。
- 不修改 `user/auth`。
- 不修改 `service-gateway`。
- 微信和 QQ 均复用现有 OAuth start URL 跳转；不调用不存在的 `modal-config` 接口。
- 手机号登录复用现有 `PhoneLoginForm`。

## Current Implementation

### 国内站弹窗

- `LoginModal` 维护 `DomesticLoginMethod = "wechat" | "phone" | "qq"`。
- 弹窗打开时默认重置为微信登录。
- 当前选中的登录方式展示在主体区域；另外两种登录方式展示在底部“其他登录方式”。
- 国际站仍走原有 Google / GitHub 登录逻辑，不进入国内站三方式状态机。

### 微信 / QQ

- 微信主体展示“微信账号登录”按钮，QQ 主体展示“QQ账号登录”按钮。
- 两者均复用 `repositories.auth.getOAuthStartUrl(...)` 和 `redirectToOAuthStart(...)`。
- 微信按 user agent 选择现有 OAuth target：
  - 桌面浏览器：`website`
  - 微信内浏览器：`official_account`
  - 普通移动浏览器：提示“请在微信中打开当前页面后继续登录。”
- 不嵌入二维码、不加载微信 JS、不新增后端配置接口；如果后端不支持扫码弹窗，按 QQ 的按钮跳转方式回退。

### 手机登录

- 手机主体复用 `PhoneLoginForm` 的 `variant="modal"`。
- 手机登录标题保留为“手机登录”，副标题“使用手机号和短信验证码登录”已删除。
- 表单可访问 label 保留，但视觉上使用 `sr-only` 隐藏，不再显示“手机号 / 短信验证码”字段标题。
- 输入框文字使用普通字重；输入框、验证码按钮使用 `rounded-md` 和轻边框，聚焦态保持浅色 1px ring。
- 未输入手机号或验证码时，登录按钮禁用。
- 手机号 / 验证码校验错误分别显示在对应输入框下方，并同步将对应输入框边框置为红色。
- 手机登录的协议勾选放在登录按钮上方；微信 / QQ 的协议勾选位于主体按钮下方、“其他登录方式”上方。

### 其他登录方式

- 底部按钮为 logo + 文案，无按钮框线。
- 微信、QQ、手机 icon 使用固定 icon slot，统一视觉大小；两个其他登录方式之间使用竖线分隔。
- 国内站内容容器底部保留 `pb-6`，避免底部登录选项贴近弹窗下边框。

## Tasks

- [x] 更新登录弹窗国内站状态机：`wechat | phone | qq`。
- [x] 默认方式设置为微信，弹窗打开时重置到微信。
- [x] 微信主体改为 OAuth 跳转按钮，保留微信 logo。
- [x] 手机主体展示手机号验证码登录表单。
- [x] QQ 主体展示 OAuth 跳转按钮，保留 QQ logo。
- [x] 协议勾选移动到“其他登录方式”上方。
- [x] 底部其他方式按钮改为无边框、logo + 文案、竖线分隔。
- [x] 回退微信扫码 / 快捷登录嵌入方案，不新增 `modal-config` 后端接口。
- [x] 统一底部微信 / QQ / 手机 icon 视觉尺寸。
- [x] 手机登录删除副标题和视觉字段标题，改为轻量表单结构。
- [x] 手机登录协议勾选移动到登录按钮上方。
- [x] 手机登录输入框样式按 `DESIGN.md` 调整为轻边框、`rounded-md`、普通字重、浅聚焦态。
- [x] 手机登录错误提示改为字段下方红字，并同步红色边框。
- [x] 手机登录未填手机号或验证码时禁用登录按钮。
- [x] 增加弹窗底部空间，避免其他登录方式贴近下边框。
- [x] 更新国内站登录弹窗单测。
- [x] 更新手机号登录表单单测。
- [x] 更新 i18n 文案。
- [x] 修复 review 发现的动态创建失败文案 i18n 字典回退问题。
- [x] 补充微信移动端 fallback 与手机登录协议 gate 的 LoginModal 回归测试。
- [x] 更新认证模块长期规格，区分 `/auth/sign-in` 手机主路径和共享登录弹窗微信默认状态机。
- [ ] 用户验收后再进入提交 / MR / 归档流程。

## Verification

- `pnpm --dir frontend exec vitest run src/components/site/__tests__/login-modal.test.tsx src/components/site/__tests__/login-modal.global.test.tsx src/components/auth/__tests__/phone-login-form.test.tsx src/pages/marketing/__tests__/agent-create-error.test.ts`
- `pnpm --dir frontend i18n:check`
- `pnpm --dir frontend check`
# 2026-08-06 Frontend release Docker monorepo context fix

**Status:** 实现与验证完成，等待用户确认提交。

**Goal:** 修复 frontend 正式镜像构建无法解析仓库内 `file:../velalink` 依赖的问题，同时保持 Docker build context 最小化。

**Scope:** 仅调整 frontend release bundle、Dockerfile、Dockerfile 专属 ignore 和构建契约测试；不修改 frontend 或 velalink 运行时代码。

## Tasks

- [x] 将 frontend release bundle 的 build context 切换为仓库根，并把 `velalink` 纳入变更触发范围。
- [x] 更新 Dockerfile 的根目录相对 COPY 路径，显式复制 `/velalink`。
- [x] 用 Dockerfile 专属 ignore 仅放行 `frontend/` 与 `velalink/`。
- [x] 运行契约测试、diff 检查和真实 Tokyo `linux/amd64` 构建推送验证。

## Verification

- `python3 .ci/runtime/tests/contract_tests/test_build_release_image.py`
- `python3 .ci/runtime/tests/contract_tests/test_release_bundle_contracts.py ReleaseBundleContractTests.test_frontend_playground_release_uses_beijing_registry`
- 国内构建机真实执行 `build_release_image.py --service frontend --env sandbox-jp-1 --platform linux/amd64 --push --reuse-existing`
- JP TCR manifest：`frontend-6cf545e930d2`，`linux/amd64`
- `git diff --check`

---
