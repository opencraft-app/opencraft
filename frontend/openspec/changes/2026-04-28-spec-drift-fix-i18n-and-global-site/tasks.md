# Tasks

本次为 **pure documentation drift-fix**，源码先行已落地，无任务需要"实现"。

## 文档同步

- [x] `specs/marketing.md`：Landing 分区组件表补 `where-to-use` / `landing-navbar`
      / `constants.ts` 的区域化与 i18n 说明
- [x] `specs/marketing.md`：`changelog-page.tsx` 描述补文案 + 配图的 region 分叉约定
- [x] `specs/marketing.md`：业务规则 4 改为「i18n 与文案抽取」
- [x] `specs/marketing.md`：新增业务规则 10「区域化编译期分支 / 双产物」
- [x] `specs/marketing.md`：新增业务规则 11「`<LanguageSwitcher>` 仅国际站、双形态、
      持久化、切语言不切图」
- [x] `specs/marketing.md`：技术债清理"Landing 中文硬编码"，新增 i18n 翻译完整性条
- [x] `specs/auth.md`：业务规则 6 改为「OAuth 区域差异（编译期分支）」

## 验证（不涉及代码）

- [x] 检查 `specs/marketing.md` / `specs/auth.md` 与源码一致：
      - `src/lib/region.ts` / `src/lib/oauth.ts` / `src/i18n/*`
      - `src/components/site/language-switcher.tsx`
      - `src/pages/marketing/landing/where-to-use-section.tsx`
      - `src/pages/marketing/changelog-page.tsx`
      - `package.json` scripts（`build:cn` / `build:global` / `i18n:*` / `deploy:cf`）

## 归档

- [ ] 通过 review 后执行 `feai-archive`：
      - 将 `specs/marketing.md` / `specs/auth.md` 覆盖 `openspec/specs/` 对应文件
        （本次已**同步改**了 `openspec/specs/*`，归档时直接移动 change 目录到
        `openspec/changes/archive/` 即可）
      - 归档路径：`openspec/changes/archive/2026-04-28-spec-drift-fix-i18n-and-global-site/`
