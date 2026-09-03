# 首页登录态产品入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Repository workflow is `single_agent`; do not dispatch subagents unless the user explicitly requests them.

**Goal:** 为国内站和国际站首页的登录态头部增加常驻产品入口，使用全部现有 locale 的确认文案并直达 `/agents`。

**Architecture:** 在共享 `PublicHeaderAuthIsland` 增加默认关闭的首页入口开关，由 `PublicHomePage` 单独开启。登录态动作区使用原生链接渲染桌面和移动按钮，复用现有埋点，不改未登录 CTA、其他公共页面或 `/agents` 守卫。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript 5.9、Tailwind CSS v4、Vitest 4、Testing Library。

## Global Constraints

- 设计事实源：`openspec/changes/2026-08-31-homepage-auth-entry-design.md`。
- 实现前必须先处理 `openspec/plan.md` 中已完成但未归档的“首页加载性能优化”计划，再把本计划登记为当前未完成任务；不得覆盖或误归档他人的进行中工作。
- 仅首页显式开启入口；About、Changelog、Docs、Subscribe 等其他公共页面保持现状。
- 仅 `authReady === true` 且 `isAuthenticated === true` 时显示。
- 桌面端和移动端均位于头像左侧；国际站语言切换仍位于按钮左侧。
- 点击始终使用原生链接进入 `/agents`，不复用订阅或智能体数量分流。
- 文案固定为：`开始使用 / 開始使用 / Enter LightVela / Masuk ke LightVela / Entrar a LightVela / LightVelaを開く / LightVela 열기`。
- 未登录首页、Hero、页尾 CTA、头像菜单、认证、订阅和创建流程均不得改变。
- 不新增依赖，不手改生成的 i18n 文件。
- 未经用户单独确认，不执行 commit、push 或 MR。

---

## File Map

- Modify: `next-site/public-header-auth-island.tsx` — locale 文案、首页入口开关、登录态桌面/移动链接与点击埋点。
- Modify: `next-site/public-pages.tsx` — 仅 `PublicHomePage` 开启入口。
- Modify: `next-site/__tests__/public-header-auth-island.test.tsx` — 登录/退出态、首页开关、八种 locale、链接和埋点回归。
- Modify: `openspec/plan.md` — 在旧计划完成归档后登记本需求的单个未完成任务。
- Modify: `openspec/changes/2026-08-31-homepage-auth-entry-design.md` — 实施完成后更新状态与验证结论。

### Task 1: 首页登录态入口

**Files:**
- Modify: `next-site/public-header-auth-island.tsx:33-188`
- Modify: `next-site/public-pages.tsx:72-101`
- Modify: `next-site/__tests__/public-header-auth-island.test.tsx:1-38`
- Modify: `openspec/plan.md`
- Modify: `openspec/changes/2026-08-31-homepage-auth-entry-design.md`

**Interfaces:**
- Consumes: `PublicHeaderAuthIslandProps`、`PublicSiteLocale`、`AGENTS_HOME_PATH`、`trackDatongClick`、`DATONG_PAGE_IDS.HOME`。
- Produces: `showProductEntry?: boolean`；默认 `false`，仅首页传入 `true`。
- Produces: locale copy 字段 `enterProduct: string`，覆盖 `PublicSiteLocale` 的全部八个成员。
- Produces: 两个语义相同的原生链接，桌面埋点 surface 为 `desktop`，移动端为 `mobile`。

- [x] **Step 1: 先写失败测试，锁定登录态、首页范围和全部文案**

将测试桩改为可变状态，并保留现有西班牙语退出态回归：

```tsx
const runtimeMock = vi.hoisted(() => ({
  language: 'es',
  authReady: true,
  isAuthenticated: false,
}));
const trackDatongClickMock = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: runtimeMock.language } }),
}));
vi.mock('@/contexts/session-context', () => ({
  useSession: () => ({
    authReady: runtimeMock.authReady,
    isAuthenticated: runtimeMock.isAuthenticated,
  }),
}));
vi.mock('@/observability/datong-tracker', () => ({
  trackDatongClick: trackDatongClickMock,
}));
```

增加表驱动文案测试：

```tsx
it.each([
  ['zh-CN', '开始使用'],
  ['zh-SG', '开始使用'],
  ['zh-Hant', '開始使用'],
  ['en-US', 'Enter LightVela'],
  ['id-ID', 'Masuk ke LightVela'],
  ['es', 'Entrar a LightVela'],
  ['ja-JP', 'LightVelaを開く'],
  ['ko-KR', 'LightVela 열기'],
] as const)('shows the homepage product entry for %s', (locale, label) => {
  runtimeMock.isAuthenticated = true;
  render(
    <PublicHeaderAuthIsland
      locale={locale}
      showLanguageSwitcher={false}
      showProductEntry
    />,
  );

  const links = screen.getAllByRole('link', { name: label });
  expect(links).toHaveLength(2);
  for (const link of links) {
    expect(link).toHaveAttribute('href', '/agents');
  }
});
```

增加范围与埋点测试：

```tsx
it('keeps the product entry off non-home public pages', () => {
  runtimeMock.isAuthenticated = true;
  render(<PublicHeaderAuthIsland locale="en-US" showLanguageSwitcher={false} />);
  expect(screen.queryByRole('link', { name: 'Enter LightVela' })).not.toBeInTheDocument();
});

it('keeps anonymous homepage actions unchanged', () => {
  runtimeMock.isAuthenticated = false;
  render(
    <PublicHeaderAuthIsland
      locale="zh-CN"
      showLanguageSwitcher={false}
      showProductEntry
      promoteFreeTrial
    />,
  );
  expect(screen.queryByRole('link', { name: '开始使用' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '免费试用' })).toBeInTheDocument();
});

it('tracks the desktop product entry without changing its native target', () => {
  runtimeMock.isAuthenticated = true;
  render(
    <PublicHeaderAuthIsland locale="en-US" showLanguageSwitcher={false} showProductEntry />,
  );
  const link = screen.getAllByRole('link', { name: 'Enter LightVela' })[0]!;
  link.addEventListener('click', (event) => event.preventDefault());
  fireEvent.click(link);
  expect(trackDatongClickMock).toHaveBeenCalledWith('agent_enter_console_btn', {
    pgid: 'home',
    params: { surface: 'desktop', target: '/agents' },
  });
});
```

- [x] **Step 2: 运行测试并确认 RED**

Run:

```bash
cd frontend
pnpm exec vitest run --config vitest.config.ts next-site/__tests__/public-header-auth-island.test.tsx --api.host 127.0.0.1
```

Expected: FAIL。`PublicHeaderAuthIslandProps` 尚无 `showProductEntry`，且登录态尚未渲染目标链接。

- [x] **Step 3: 最小实现 locale 文案与首页入口开关**

扩展 copy 类型和每个 locale：

```tsx
const copyByLocale: Record<
  PublicSiteLocale,
  { createNow: string; enterProduct: string; freeTrial: string; login: string }
> = {
  'en-US': { createNow: 'Create Now', enterProduct: 'Enter LightVela', freeTrial: 'Free trial', login: 'Sign In' },
  'zh-CN': { createNow: '立即创建', enterProduct: '开始使用', freeTrial: '免费试用', login: '登录' },
  'zh-SG': { createNow: '立即创建', enterProduct: '开始使用', freeTrial: '免费试用', login: '登录' },
  'zh-Hant': { createNow: '立即創建', enterProduct: '開始使用', freeTrial: '免費試用', login: '登入' },
  'id-ID': { createNow: 'Buat Sekarang', enterProduct: 'Masuk ke LightVela', freeTrial: 'Coba Gratis', login: 'Masuk' },
  es: { createNow: 'Crear ahora', enterProduct: 'Entrar a LightVela', freeTrial: 'Prueba gratis', login: 'Iniciar sesión' },
  'ja-JP': { createNow: '今すぐ作成', enterProduct: 'LightVelaを開く', freeTrial: '無料で試す', login: 'ログイン' },
  'ko-KR': { createNow: '지금 만들기', enterProduct: 'LightVela 열기', freeTrial: '무료 체험', login: '로그인' },
};
```

扩展 props，并在参数中默认关闭：

```tsx
type PublicHeaderAuthIslandProps = {
  appearance?: HeaderAppearance;
  locale?: PublicSiteLocale;
  oauthError?: string | null;
  showLanguageSwitcher?: boolean;
  showProductEntry?: boolean;
  promoteFreeTrial?: boolean;
};

function PublicHeaderAuthControls({
  appearance = 'solid',
  locale,
  oauthError = null,
  showLanguageSwitcher = isGlobal,
  showProductEntry = false,
  promoteFreeTrial = false,
}: PublicHeaderAuthIslandProps) {
```

在登录态分支中分别渲染桌面和移动原生链接：

```tsx
const renderProductEntry = (surface: 'desktop' | 'mobile') => {
  if (!showProductEntry) return null;
  const isMobile = surface === 'mobile';
  return (
    <a
      href={AGENTS_HOME_PATH}
      onClick={() => {
        trackDatongClick('agent_enter_console_btn', {
          pgid: DATONG_PAGE_IDS.HOME,
          params: { surface, target: AGENTS_HOME_PATH },
        });
      }}
      className={cn(
        'inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-[100px] border border-black/90 bg-black/90 font-heading font-medium text-white shadow-[0_2px_0_rgba(187,187,187,0.05)] hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2',
        isMobile ? 'h-[32px] px-3 text-[13px]' : 'h-[36px] px-4 text-sm xl:px-5',
      )}
    >
      {copy.enterProduct}
    </a>
  );
};

if (isAuthenticated) {
  return (
    <>
      <div className="hidden shrink-0 items-center gap-2 lg:flex xl:gap-3">
        {showLanguageSwitcher && renderNextLanguageSwitcher({ activeLocale, reloadAfterSwitch: false, variant: 'dropdown' })}
        {renderProductEntry('desktop')}
        <UserAvatarMenu />
      </div>
      <div className="ml-auto flex items-center gap-2 lg:hidden">
        {renderProductEntry('mobile')}
        <UserAvatarMenu />
      </div>
    </>
  );
}
```

- [x] **Step 4: 仅在首页开启入口**

在 `PublicHomePage` 的 Auth Island 上增加开关；其他调用点不传：

```tsx
<PublicHeaderAuthIsland
  appearance="immersive"
  locale={locale}
  oauthError={new URLSearchParams(locationSearch).get('oauth_error')}
  showLanguageSwitcher
  showProductEntry
  promoteFreeTrial
/>
```

- [x] **Step 5: 运行定向测试并确认 GREEN**

Run:

```bash
cd frontend
pnpm exec vitest run --config vitest.config.ts next-site/__tests__/public-header-auth-island.test.tsx --api.host 127.0.0.1
```

Expected: 目标测试文件全部 PASS；原西班牙语退出态用例继续 PASS。

补充静态范围核对：

```bash
rg -n "showProductEntry" next-site/public-header-auth-island.tsx next-site/public-pages.tsx
```

Expected: 除组件的类型、默认值和渲染判断外，仅 `PublicHomePage` 调用点传入该开关；其他公共页面调用点不传。

- [x] **Step 6: 运行前端质量门禁**

Run:

```bash
cd frontend
pnpm i18n:check
pnpm check
cd ..
git diff --check -- \
  frontend/next-site/public-header-auth-island.tsx \
  frontend/next-site/public-pages.tsx \
  frontend/next-site/__tests__/public-header-auth-island.test.tsx \
  frontend/openspec/plan.md \
  frontend/openspec/changes/2026-08-31-homepage-auth-entry-design.md \
  frontend/openspec/changes/2026-08-31-homepage-auth-entry-implementation-plan.md
```

Expected: i18n 结构错误为 0；TypeScript 无新增 diagnostics；`git diff --check` 无输出。

- [x] **Step 7: 浏览器回验双站与移动端**

分别以国内和国际构建变量启动本地页面，复用可用登录态：

```bash
cd frontend
NEXT_PUBLIC_REGION=cn VITE_REGION=cn pnpm exec next dev -H 127.0.0.1 -p 5184
NEXT_PUBLIC_REGION=global VITE_REGION=global pnpm exec next dev -H 127.0.0.1 -p 5185
```

验收：

- 国内桌面登录态显示“开始使用”，国际英文显示“Enter LightVela”。
- 390px 下按钮和头像不重叠、不产生横向溢出。
- 点击链接实际进入 `/agents`。
- 未登录时不出现产品入口，原免费试用和登录动作保持不变。

- [x] **Step 8: 更新规格验证结论并准备提交预览**

在 Design 的状态和验证段写入实际测试数量、门禁结果和浏览器结论；展示以下内容等待用户确认，不执行提交：

```text
变更文件列表
测试与质量门禁结果
浏览器验收结果
建议 commit message：增加首页登录态入口 / feat(frontend): add signed-in homepage entry
```

## Result

- TDD RED：12 个目标用例中 9 个因入口尚未实现按预期失败；已有退出态与范围用例继续通过。
- TDD GREEN：目标文件 12/12，通过公共导航相关回归后为 24/24。
- 质量门禁：`pnpm i18n:check`、`pnpm check`、`pnpm build:cn`、`pnpm build:global` 和范围内 `git diff --check` 通过；TypeScript 无新增 diagnostics。
- 范围：`showProductEntry` 仅由 `PublicHomePage` 显式开启，其他公共页面保持默认关闭。
- 浏览器：国内站“开始使用”和国际站“Enter LightVela”在真实登录态桌面与 390px 视口可见，页面宽度与 scroll width 一致；点击均进入 `/agents/`。
- 退出态：未改动真实账号状态，使用自动化用例确认入口不出现且原“免费试用”动作保持不变。
- 提交状态：未 commit、未 push、未创建 MR，等待用户确认。
