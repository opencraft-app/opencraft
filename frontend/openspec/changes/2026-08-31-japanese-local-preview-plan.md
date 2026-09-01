# 日语本地预览 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让国际站本地开发地址 `http://127.0.0.1:5174/` 可切换并访问日语，同时保证国内站和生产构建继续隐藏日语。

**Architecture:** 在 locale 注册表旁新增纯函数，根据“区域、生产状态、显式预览 locale 字符串”派生运行时 locale 集合；公开路由、切换器和 i18n 输入共用该集合。只有 `dev:global` 注入 `NEXT_PUBLIC_PREVIEW_LOCALES=ja-JP`，生产构建脚本不注入且纯函数强制拒绝生产/国内预览。

**Tech Stack:** TypeScript 5.9、Next.js 16、React 19、Vitest 4、i18next。

## Global Constraints

- `frontend/src/i18n/locales.json` 中日语的 `switcherVisible` 与 `translationRequired` 保持 `false`。
- `NEXT_PUBLIC_PREVIEW_LOCALES` 仅在 `NODE_ENV !== "production"` 且 `NEXT_PUBLIC_REGION=global` 时生效。
- 未注册 locale、生产环境与国内站均忽略预览值。
- 不新增依赖，不修改现有切换器视觉样式，不提交、不推送、不创建 MR。

---

### Task 1: 注册表运行时预览派生

**Files:**
- Modify: `frontend/src/i18n/locales.config.ts`
- Test: `frontend/src/i18n/__tests__/locales.config.test.ts`

**Interfaces:**
- Consumes: `LocaleDefinition`、`LOCALE_DEFINITIONS`、`publishedLocaleDefinitions()`
- Produces: `runtimeLocaleDefinitions(options): readonly LocaleDefinition[]`、`parseRuntimeLocaleCode(value, options): LocaleCode | null`

- [x] **Step 1: 写失败测试**

```ts
expect(runtimeLocaleDefinitions({
  region: "global",
  isProduction: false,
  previewLocales: "ja-JP",
}).map((item) => item.code)).toContain("ja-JP");
expect(runtimeLocaleDefinitions({
  region: "global",
  isProduction: true,
  previewLocales: "ja-JP",
}).map((item) => item.code)).not.toContain("ja-JP");
expect(runtimeLocaleDefinitions({
  region: "cn",
  isProduction: false,
  previewLocales: "ja-JP",
}).map((item) => item.code)).not.toContain("ja-JP");
expect(parseRuntimeLocaleCode("unknown", {
  region: "global",
  isProduction: false,
  previewLocales: "ja-JP",
})).toBeNull();
```

- [x] **Step 2: 运行测试并确认 RED**

Run: `pnpm vitest run src/i18n/__tests__/locales.config.test.ts`

Expected: FAIL，提示 `runtimeLocaleDefinitions` / `parseRuntimeLocaleCode` 尚未导出。

- [x] **Step 3: 最小实现**

```ts
export type RuntimeLocaleOptions = {
  readonly region: "cn" | "global";
  readonly isProduction: boolean;
  readonly previewLocales?: string | null;
  readonly definitions?: readonly LocaleDefinition[];
};

export function runtimeLocaleDefinitions(options: RuntimeLocaleOptions): readonly LocaleDefinition[] {
  const definitions = options.definitions ?? LOCALE_DEFINITIONS;
  const published = publishedLocaleDefinitions(definitions);
  if (options.region !== "global" || options.isProduction || !options.previewLocales) {
    return published;
  }
  const requested = new Set(options.previewLocales.split(",").map((value) => value.trim()));
  return definitions.filter((definition) => (
    published.includes(definition) || requested.has(definition.code)
  ));
}
```

- [x] **Step 4: 运行测试并确认 GREEN**

Run: `pnpm vitest run src/i18n/__tests__/locales.config.test.ts`

Expected: PASS。

### Task 2: 路由、切换器与 i18n 共用预览集合

**Files:**
- Modify: `frontend/src/lib/public-site-routing.ts`
- Modify: `frontend/next-site/public-locale.ts`
- Modify: `frontend/next-site/docs-route-publication.ts`
- Modify: `frontend/src/i18n/index.ts`
- Modify: `frontend/package.json`
- Test: `frontend/next-site/__tests__/public-locale.test.ts`
- Test: `frontend/next-site/__tests__/docs-route-publication.test.ts`
- Test: `frontend/src/i18n/__tests__/initial-locale.test.ts`
- Test: `frontend/src/components/site/__tests__/language-switcher.test.tsx`

**Interfaces:**
- Consumes: `runtimeLocaleDefinitions()`、`parseRuntimeLocaleCode()`
- Produces: 开发国际站的 `PUBLIC_RUNTIME_URL_LANGS` / `SWITCHER_VISIBLE_LOCALES` 含 `ja-jp` / `ja-JP`

- [x] **Step 1: 写失败测试**

```ts
vi.stubEnv("NODE_ENV", "development");
vi.stubEnv("NEXT_PUBLIC_REGION", "global");
vi.stubEnv("NEXT_PUBLIC_PREVIEW_LOCALES", "ja-JP");
vi.resetModules();
const preview = await import("@next-site/public-locale");
expect(preview.PUBLIC_RUNTIME_URL_LANGS).toContain("ja-jp");
expect(preview.publicRouteLocaleFromLang("ja-jp")).toEqual({
  locale: "ja-JP",
  localized: true,
});
```

- [x] **Step 2: 运行测试并确认 RED**

Run: `pnpm vitest run next-site/__tests__/public-locale.test.ts src/i18n/__tests__/initial-locale.test.ts src/components/site/__tests__/language-switcher.test.tsx`

Expected: FAIL，开发预览集合仍不包含日语。

- [x] **Step 3: 接入环境派生并配置开发脚本**

```ts
const runtimeOptions = {
  region: isGlobal ? "global" : "cn",
  isProduction: process.env.NODE_ENV === "production",
  previewLocales: process.env.NEXT_PUBLIC_PREVIEW_LOCALES,
} as const;
```

`dev:global` 增加 `NEXT_PUBLIC_PREVIEW_LOCALES=ja-JP`；`build:global` 与 `build:cn` 保持不变。

- [x] **Step 4: 运行定向测试并确认 GREEN**

Run: `pnpm vitest run src/i18n/__tests__/locales.config.test.ts next-site/__tests__/public-locale.test.ts next-site/__tests__/docs-route-publication.test.ts src/i18n/__tests__/initial-locale.test.ts src/components/site/__tests__/language-switcher.test.tsx`

Expected: PASS。

### Task 3: 门禁与浏览器验收

**Files:**
- Modify: `frontend/openspec/plan.md`
- Create outside repository: `/tmp/lightvela-ja-preview-validation/report.json`
- Create outside repository: `/tmp/lightvela-ja-preview-validation/report.html`

**Interfaces:**
- Consumes: `pnpm dev:global`、5174 本地预览
- Produces: 日语入口、日语首页/Docs/法务页的可复核证据

- [x] **Step 1: 运行质量门禁**

Run: `pnpm check`

Expected: exit 0。

Run: `pnpm build:global && test ! -e out/ja-jp/index.html`

Expected: exit 0，生产国际站仍不生成日语首页。

Run: `pnpm build:cn && test ! -e out/ja-jp/index.html`

Expected: exit 0，国内站不生成日语首页。

- [x] **Step 2: 启动开发预览**

Run: `pnpm dev:global`

Expected: `http://127.0.0.1:5174/` ready，语言菜单出现 `International Site - 日本語`。

- [x] **Step 3: 浏览器验收**

```text
桌面首页：菜单出现日本語，点击后进入 /ja-jp/
日语首页：html lang=ja-JP，主要标题为日文
日语 Docs：/ja-jp/docs/overview 可访问且导航/正文为日文
日语法务：/ja-jp/privacy-policy 可访问
移动端：语言菜单可操作且无横向溢出
```

- [x] **Step 4: 记录结果**

在仓库外生成 JSON + HTML 报告，并将 `frontend/openspec/plan.md` 的本地浏览器验收项标为完成；生产发布标记仍保持关闭。
