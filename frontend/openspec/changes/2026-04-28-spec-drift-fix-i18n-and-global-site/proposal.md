# Spec Drift Fix — i18n & Global Site（2026-04-28）

## 背景

最近数次迭代在前端落地了国际站（`lightvela.com`）能力与 i18n 体系，但
`openspec/specs/*` 尚未同步，属于典型的 spec drift：

- **i18n 运行时**：引入 `react-i18next` + 自研「中文即 key」方案（`src/i18n/`），
  业务侧通过 `useT()` 调用，`pnpm i18n:extract` / `pnpm i18n:check` 管理字典。
- **区域化编译期分支**：新增 `src/lib/region.ts`（`REGION` / `isCN` / `isGlobal`
  / `DEFAULT_LOCALE`）；Vite 构建期按 `VITE_REGION` 做常量替换 + Tree-shake。
- **双产物**：`pnpm build:cn` → `dist-cn/`（国内 shprod 部署），
  `pnpm build:global` → `dist-global/`（Cloudflare Pages，`pnpm deploy:cf`）。
- **LanguageSwitcher**：新增 `src/components/site/language-switcher.tsx`，
  **仅国际站** 在 `LandingNavbar` 挂载，支持桌面 dropdown / 移动 inline 两种形态。
- **首页 Where-to-Use 平台卡片**：按 `isGlobal` 分叉——国内站 QQ / 微信 / 飞书 /
  企业微信；国际站 Telegram / WhatsApp / Discord / Slack。
- **ChangelogPage**：新增"接入通道"文案按 `isGlobal` 分叉；**国际站配图固定英文版**
  （即使用户切回中文也不变），避免同站点出现国内渠道图标错位。
- **OAuth 渠道按 region 选定**：`VISIBLE_OAUTH_PROVIDERS`（`src/lib/oauth.ts`）
  国内站 QQ/微信、国际站 Google/GitHub；GitHub 国内彩蛋由
  `ALLOW_GITHUB_EASTER_EGG` 看守。
- **用户语言切换持久化**：`localStorage.lw-locale`，未命中回落到
  `region.DEFAULT_LOCALE`（cn → `zh-CN`，global → `en-US`）。

这些能力已在主干稳定运行，但 `specs/marketing.md` 仍写着"Landing 大量中文文案
硬编码，未来做国际站时需要集中抽取"，`specs/auth.md` 的 OAuth 规则仅一句
"第三方登录仅在对应渠道开放时可用"，完全未体现区域差异。

## 本次改动（纯文档）

1. **`openspec/specs/marketing.md`**
   - Landing 分区组件表：`where-to-use-section` 补国际化卡片说明；
     `landing-navbar` 补 `<LanguageSwitcher>` 挂载条件；
     `constants.ts` 注明"不再承载中文文案"。
   - `changelog-page.tsx` 描述补 region 分叉（文案 + 配图），明确"国际站配图
     始终英文版"的约定。
   - 业务规则 4：「文案统一由 `landing/constants.ts` 管理」→ 改为「i18n 与文案
     抽取」约定（`useT()` + extract / check 流程）。
   - 新增业务规则 10：「区域化编译期分支」与双产物构建约定。
   - 新增业务规则 11：`<LanguageSwitcher>` 仅国际站、双形态挂载、持久化、
     "切语言不切图"的边界。
   - 已知技术债：移除「Landing 大量中文硬编码」，新增「i18n 字典
     `pnpm i18n:check` 清单需为空再发国际站」。

2. **`openspec/specs/auth.md`**
   - 业务规则 6「OAuth 降级」→ 改为「OAuth 区域差异（编译期分支）」，
     列明国内站（QQ/微信 + GitHub 彩蛋）与国际站（Google/GitHub）的 provider
     集合，指向 `src/lib/oauth.ts` 的 `VISIBLE_OAUTH_PROVIDERS` 与
     `ALLOW_GITHUB_EASTER_EGG`。

3. **`openspec/config.yaml`**：无需变更，已在先前迭代同步完成
   （schema: spec-driven；drift-fix · 2026-04-28 版本；已包含 i18n / region /
   双产物 / LanguageSwitcher / asset-url 最新条目）。

## 非目标（本次不做）

- 不动任何源码。
- 不新增测试（功能已有测试覆盖，本次只是文档同步）。
- 不变更 `plan.md` / `bot.md`（当前与国际站无强耦合差异）。
- 不清理 `src/lib/asset-url.ts::isUsingCdn` 的冗余导出（保留为"已知技术债"）。

## 影响面

- 仅 `openspec/specs/*.md` 文档，无代码变更。
- 归档后可作为 AI Agent 后续迭代的上下文依据，保证"只改国内站 / 只改国际站"
  类需求能被准确定位到 `isCN` / `isGlobal` 分支，避免再次出现"切语言导致国际站
  出现 QQ/微信"的回归。
