# 国际站 V2 首页性能优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** 实现与验证完成，未提交。fragment Server Component 实验因真实 RSC 未减小而撤回。

**Goal:** 在不改变国际站 V2 首页视觉、文案、locale 和登录行为的前提下，去除一份重复 i18n client chunk、延迟并缩小评价头像、修复 18 个场景子按钮的 click/键盘操作，并验证 fragment 边界建议的真实收益。

**Architecture:** 将持久 layout 使用的 App Provider 树移动到不导入 `@/i18n/t` 的独立 client module，并用无字典的共享 i18next 注册消除 shell warning。评价头像由可复用 sharp helper 生成 64×64 WebP 并机械改写全部 fragment；场景切换复用同一个 activate handler 处理 hover、click、Enter 与 Space。Server Component fragment 实验未减少 Flight/RSC，已恢复原边界。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript 5.9、Vitest 4、JSDOM、sharp、静态 HTML/JavaScript。

## Global Constraints

- 基线固定为 `origin/master` @ `e287348a5152d4dc751c0db51db9a3983dd1ec07`。
- 不异步化 `src/i18n/index.ts`，不移除 locale，不改变 hydration 时序。
- 不拆完整 marketing layout，不修改 API、鉴权、计费、发布和缓存配置。
- 不重写三段动效 IIFE；本阶段不声称解决 timer/listener/observer 泄漏。
- 首页文案、视觉结构、七 locale 路由、header auth island 和国内站行为必须保持不变。
- 所有生产代码都先有预期失败测试，再写最小实现并恢复 GREEN。
- 真实收益以 `pnpm build:global` 产物为准，不以源码推测或单轮 Lighthouse 宣称 LCP 收益。
- 未经用户单独确认，不 commit、push、创建 MR 或发布；计划中的任务完成后只展示 diff 和验证证据。

---

### Task 1: 收窄 layout 的 i18n client boundary

**Files:**
- Create: `frontend/next-site/public-site-app-providers.tsx`
- Create: `frontend/src/i18n/default-agent-name.ts`
- Create: `frontend/src/i18n/react-instance-registration.ts`
- Create: `frontend/src/i18n/__tests__/default-agent-name.test.ts`
- Modify: `frontend/next-site/public-site-providers.tsx`
- Modify: `frontend/src/app/(site)/layout.next.tsx`
- Modify: `frontend/next-site/public-header-auth-island.tsx`
- Modify: `frontend/src/components/site/cookie-consent-banner.tsx`
- Modify: `frontend/src/components/site/__tests__/cookie-consent-banner.test.tsx`
- Modify: `frontend/src/repositories/http-repositories.ts`
- Modify: `frontend/next-site/__tests__/public-site-providers.test.tsx`

**Interfaces:**
- Produces: `PublicSiteAppProviders({ children }: { children: ReactNode })`
- Produces: `defaultHermesAgentName(): string` without importing `@/i18n/t`
- Keeps: `PublicSiteLocaleBridge` and `PublicSiteProviders` exports from `public-site-providers.tsx`

- [x] **Step 1: 写失败测试锁定无 i18n 的 layout boundary**

在 `public-site-providers.test.tsx` 增加源码契约：layout 必须从 `@next-site/public-site-app-providers` 导入；新模块存在且不包含 `@/i18n/t`、`LocaleOverrideProvider` 或 `PublicSiteLocaleBridge`；原 locale bridge 仍能把 `es` 映射为 `es`。

```ts
it("keeps the persistent app provider boundary free of locale dictionaries", () => {
  const layout = readFileSync(path.join(frontendRoot, "src/app/(site)/layout.next.tsx"), "utf8");
  const appProviders = readFileSync(path.join(frontendRoot, "next-site/public-site-app-providers.tsx"), "utf8");
  expect(layout).toContain("@next-site/public-site-app-providers");
  expect(appProviders).not.toMatch(/@\/i18n\/t|LocaleOverrideProvider|PublicSiteLocaleBridge/);
});
```

- [x] **Step 2: 运行测试并确认 RED**

Run: `pnpm exec vitest run next-site/__tests__/public-site-providers.test.tsx next-site/public-site-providers.test.tsx`

Expected: FAIL，因为 `public-site-app-providers.tsx` 尚不存在且 layout 仍导入旧模块。

- [x] **Step 3: 最小拆分 provider module**

把 Repository/RuntimeConfig/Session/observability/OpenClaw/Cookie provider 树原样移动到新文件；`public-site-providers.tsx` 只保留 locale bridge，并从新文件导入 `PublicSiteAppProviders` 组合 `PublicSiteProviders`。layout 改为直接导入新文件，不改变 JSX 层级。

- [x] **Step 4: 运行聚焦测试并确认 GREEN**

Run: `pnpm exec vitest run next-site/__tests__/public-site-providers.test.tsx next-site/public-site-providers.test.tsx`

Expected: 所有 provider 测试通过，无 React warning。

- [x] **Step 5: 根据首次构建证据补 repository 边界 RED**

首次 `build:global` 仍产生两份 949,243 B raw / 2,690-key 字典 chunk。静态依赖追踪确认唯一残留链路为 `RepositoryProvider → http-repositories.ts → @/i18n/t`，用于 `t("我的Hermes")`。

先增加失败测试：`http-repositories.ts` 不得导入 `@/i18n/t`，轻量适配器文件必须存在；适配器固定 key 必须等于 `zh-to-key.json["我的Hermes"]`，给定翻译函数时返回翻译，未提供或返回空值时回退“我的Hermes”。

- [x] **Step 6: 实现轻量默认 Agent 名适配器并恢复 GREEN**

适配器只导入 `getI18n`，使用固定生成 key `k_2889ddb2` 与 `defaultValue: "我的Hermes"`；repository 改为导入 `defaultHermesAgentName`。不导入 `src/i18n/index.ts`、`src/i18n/t.ts` 或任何 JSON 字典。

- [x] **Step 7: 真实构建验证 Q1**

Run: `pnpm build:global`

Expected: build 成功；解析 `out/index.html` 的首页脚本后，最多只有一个 chunk 包含完整 eager i18n key 集合。若仍有两份，停止扩大实现并记录实际 client dependency，不改 i18n 运行时协议。

- [x] **Step 8: 收窄持久 shell 的 react-i18next 注册行为**

只调用 `setI18n(i18n)` 注册共享实例，不使用全局 `setDefaults`；在 header 与 Cookie banner 两个早于完整 locale provider 渲染的 hook 上显式传入 `{ useSuspense: false }`。同时把已与生产 locale 注册表冲突的“日文未发布”旧测试更新为日文文案与 `/ja-jp/cookie-policy` 路径断言。

---

### Task 2: 验证 Server Component 直接输出 fragment（未获收益，已撤回）

**Files:**
- Modify: `frontend/next-site/international-home-page.tsx`
- Modify: `frontend/next-site/international-home-runtime.tsx`
- Modify: `frontend/next-site/__tests__/international-home-rendering.test.tsx`

**Result:** RED/GREEN 实验实现后，`build:global` 的 `__PAGE__.txt` 仍为 102,321 B，代表性首页长句仍命中一次，最终 HTML 仍包含正文与内嵌 Flight 两份内容。该建议没有减少约 97 KB 网络载荷，相关生产代码和边界测试已撤回；保留原 `InternationalHomeRuntime({ locale, markup })`。

- [x] **Step 1: 写失败测试锁定 fragment 不再作为 client prop**

增加源码与渲染断言：`international-home-runtime.tsx` 不出现 `markup` 和 `dangerouslySetInnerHTML`；`international-home-page.tsx` 包含 `dangerouslySetInnerHTML`；`renderToStaticMarkup(<InternationalHomePage locale="en-US" />)` 仍包含首页正文。

```ts
expect(runtimeSource).not.toContain("markup");
expect(runtimeSource).not.toContain("dangerouslySetInnerHTML");
expect(pageSource).toContain("dangerouslySetInnerHTML");
expect(renderToStaticMarkup(<InternationalHomePage locale="en-US" />)).toContain(
  "Your AI companion, always here, always evolving with you",
);
```

- [x] **Step 2: 运行测试并确认 RED**

Run: `pnpm exec vitest run next-site/__tests__/international-home-rendering.test.tsx`

Expected: FAIL，因为 client runtime 仍声明 `markup` 并渲染 innerHTML。

- [x] **Step 3: 最小移动 fragment 输出边界**

`InternationalHomePage` 返回 fragment `<div dangerouslySetInnerHTML={{ __html: markup }} />` 与 `<InternationalHomeRuntime locale={locale} />`；Runtime 删除 `markup` 参数与 fragment div，保留 stylesheet、script effect 和 header actions layer。

- [x] **Step 4: 运行 rendering 与 routing 回归；随后以真实 RSC 证据判定无收益并撤回**

Run: `pnpm exec vitest run next-site/__tests__/international-home-rendering.test.tsx next-site/__tests__/international-home-page.test.tsx`

Expected: 全部通过；七 locale SSR 文案、header props、脚本重绑定和路由选择不变。

---

### Task 3: 优化评价头像生成与 fragment 属性

**Files:**
- Create: `frontend/scripts/international-home-voice-avatars.mjs`
- Create: `frontend/scripts/international-home-voice-avatars.test.ts`
- Modify: `frontend/scripts/import-international-homepage.mjs`
- Modify: `frontend/public/lightvela-intl-home/index-fragment.html`
- Modify: `frontend/public/lightvela-intl-home/index-fragment.*.html`
- Create: `frontend/public/lightvela-intl-home/assets/voice-*-64.webp`

**Interfaces:**
- Produces: `optimizeInternationalHomeVoiceAvatars(homeRoot: string): Promise<{ avatars: number; sourceBytes: number; optimizedBytes: number; fragments: number }>`
- CLI: `node scripts/international-home-voice-avatars.mjs public/lightvela-intl-home`

- [x] **Step 1: 写失败测试锁定 helper 行为**

测试在临时 home root 写入两份 locale fragment、一张 128×128 PNG 和一张聊天头像。调用 helper 后只把 `.voice .tcard img` 改为 `voice-test-64.webp`，并断言 `loading="lazy"`、`decoding="async"`、`width="32"`、`height="32"`；聊天头像不改；WebP metadata 不超过 64×64；summary 只计一个唯一 avatar。

- [x] **Step 2: 运行测试并确认 RED**

Run: `pnpm exec vitest run scripts/international-home-voice-avatars.test.ts`

Expected: FAIL，因为 helper module 尚不存在。

- [x] **Step 3: 用 sharp 和 JSDOM 实现最小 helper**

对全部 `index-fragment*.html` 收集 `.voice .tcard img` 的本地 asset URL；每个唯一源图用 `sharp(...).resize(64, 64, { fit: "cover", position: "centre" }).webp({ quality: 82, effort: 5 })` 生成 `-64.webp`，再机械写回属性和 URL。保留原图，不处理 `.voice` 外的图片。

- [x] **Step 4: 接入导入脚本并确认 helper GREEN**

`import-international-homepage.mjs` 在 fragment 和资产复制完成后调用同一 helper；运行聚焦测试，Expected: PASS。

- [x] **Step 5: 生成仓库内当前产物并验证七 locale**

Run: `node scripts/international-home-voice-avatars.mjs public/lightvela-intl-home`

Run: `pnpm exec vitest run next-site/__tests__/international-home-page.test.tsx scripts/international-home-voice-avatars.test.ts`

Expected: 七个已发布 locale 和兼容 fragment 中全部评价头像使用 lazy 64px WebP；现有链接、locale 文案和聊天图片测试通过；记录优化前后唯一资源总字节。

---

### Task 4: 修复场景子按钮 click 与键盘操作

**Files:**
- Modify: `frontend/public/lightvela-intl-home/runtime.js`
- Modify: `frontend/scripts/import-international-homepage.mjs`
- Modify: `frontend/next-site/__tests__/international-home-page.test.tsx`

**Interfaces:**
- Keeps: hover 即切换
- Adds: 原生 button click 激活同一 scene；显式 Enter/Space keydown 兜底；同步 `aria-pressed`

- [x] **Step 1: 写行为测试并确认现状 RED**

在 JSDOM 写入包含两个 `.scene__sub` 和两个 `.scene-chat` 的最小 DOM，执行真实 `runtime.js`，对第二个按钮 `click()`，断言第二个按钮获得 `on` 且第二个 chat 显示。另断言英文 fragment 恰有 18 个 `.scene__sub` 按钮。

Run: `pnpm exec vitest run next-site/__tests__/international-home-page.test.tsx`

Expected: click 行为断言 FAIL；按钮计数 PASS。

- [x] **Step 2: 最小复用 activate handler**

把当前匿名 mouseenter 回调提取为局部 `activate()`，同时注册：

```js
function activate() {
  if (active === i) return;
  render(i, true);
}
btn.addEventListener('mouseenter', activate);
btn.addEventListener('click', activate);
btn.addEventListener('keydown', activateFromKeyboard);
```

同步让 importer 对批准静态源生成相同 runtime，避免下次导入覆盖修复。

- [x] **Step 3: 运行首页 artifact 与 rendering 回归并确认 GREEN**

Run: `pnpm exec vitest run next-site/__tests__/international-home-page.test.tsx next-site/__tests__/international-home-rendering.test.tsx`

Expected: 全部通过；hover、click、既有脚本列表和 locale 行为不变。

---

### Task 5: 全量验证与产物对比

**Files:**
- Modify: `frontend/openspec/changes/2026-09-02-international-home-performance-v2-implementation-plan.md`
- Modify: `frontend/openspec/plan.md`

**Interfaces:**
- Produces: 可复现的 before/after bundle、HTML/RSC 和头像字节证据

- [x] **Step 1: 运行聚焦回归**

Run: `pnpm exec vitest run next-site/__tests__/public-site-providers.test.tsx next-site/public-site-providers.test.tsx next-site/__tests__/international-home-page.test.tsx next-site/__tests__/international-home-rendering.test.tsx scripts/international-home-voice-avatars.test.ts`

Expected: 所有测试通过，无 warning/error。

- [x] **Step 2: 运行前端门禁**

Run: `pnpm i18n:check && pnpm check`

Expected: i18n 结构检查通过；TypeScript 0 个新增诊断。

- [x] **Step 3: 构建国际站并量化首页**

Run: `pnpm build:global`

Expected: build 与全部静态导出检查通过。统计 `/`：script 数、现代 JS 压缩总量、完整字典 chunk 数、原始 HTML、RSC fragment 长句命中次数、评价头像唯一引用资源字节。

- [x] **Step 4: 浏览器 smoke**

用本次 `out/` 静态产物验证 1440×900 与 390×844：英文及至少一个 locale 路由正文存在；鼠标/触屏 click 和键盘 Enter/Space 可切换场景；语言切换和 header 登录入口正常；控制台无新增错误；页面无横向溢出。

- [x] **Step 5: 差异与计划收口，不提交**

Run: `git diff --check && git status --short && git diff --stat`

Expected: 无 whitespace error；只包含本计划列出的源码、测试、生成产物和 OpenSpec 文件。把 RED/GREEN、构建和字节对比写回计划，然后展示完整提交范围，等待用户单独确认 commit/push/MR。

## Verification Record

- TDD：provider module、repository 适配器、头像 helper、scene click/Enter/Space 均先得到预期 RED，再恢复 GREEN。CR 修正继续先锁定旧 Provider re-export 和静态 fragment 缺少初始 `aria-pressed` 的 2 个预期 RED；最小实现并补齐 helper 幂等性回归后，聚焦命令覆盖 10 个文件、117 个测试并全部通过。
- 门禁：已同步最新 `origin/master`（`4b6cb083e`）；`pnpm i18n:check` 通过；`pnpm check` 通过，TypeScript diagnostics 191 current / 276 baseline / 0 new / 85 resolved；仓库既有 i18n warning 49 条，错误 0。
- global build：Next 16.2.9 编译、592/592 静态页、SEO 与 versioned asset 检查通过；轻量实例注册后 `NO_I18NEXT_INSTANCE` 从 13 次降为 0。
- 首页 Next JS（同提交临时 worktree 对照、同机本地 Brotli）：纯 `origin/master` 与最终均为 30 个 `script[src]`；基线 4,075,348 B raw / 1,014,547 B Brotli、两份 950,607 B / 2,693-key 完整字典；最终 3,051,382 B raw / 778,284 B Brotli、仅一份 891,264 B / 2,693-key 字典。净减少 1,023,966 B raw / 236,263 B Brotli；不把脚本数量下降作为收益。
- 头像：12 个唯一源头像从 1,248,169 B 降为 25,056 B（-1,223,113 B，-98.0%）；9 份 fragment 共 216 个评价头像引用全部为 `-64.webp`、lazy、async、32×32，0 个不合规引用。
- fragment 实验：Server Component 直出版本的 `__PAGE__.txt` 仍为 102,321 B 且代表性正文命中 1 次，最终 HTML 仍含正文和内嵌 Flight 两份；无 97 KB 网络收益，已撤回生产代码。
- 浏览器：最终 `out/` 在 1440×900 英文和 390×844 西语通过；正文、18 个场景按钮、语言/账号头部、Cookie locale 正常，click / Enter / Space 均切换对应 panel，横向 overflow 为 0，console warning/error 与 framework overlay 均为 0。
- CR：`public-site-providers.tsx` 不再 re-export `PublicSiteAppProviders`，对应测试改从新边界直接导入；9 份 fragment 共 162 个 `.scene__sub` 均含静态 `aria-pressed`，每份 6 个初始 `true`；helper 单测覆盖每组唯一选中、无关标记保留与二次执行字节一致。CR 后 `pnpm check` 与 `pnpm build:global` 再次通过。
- 已将静态资源版本提升为 `20260902-home-performance-v2`，避免边缘缓存继续返回旧 runtime。MR !3533 已存在；本轮 CR 修正已提交并同步最新 `origin/master`（`aafc32ed`），合并后聚焦测试、`pnpm check` 与 global build 均通过，等待 push 更新 MR。
