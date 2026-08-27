# 国际站西语法务页面适配 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and superpowers:test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The repository remains single-agent unless the user explicitly authorizes subagents.

**Goal:** 为国际站西语路由提供完整的隐私政策、Cookie 政策和服务条款译文，同时保持开源许可证原文为英文并明确英文版本优先效力。

**Architecture:** 继续使用四个现有法务页面内的静态 typed copy 数据，不引入新依赖或运行时翻译服务。为西语新增与英文/印尼语同构的数据集和统一选择函数；开源声明只翻译解析器识别的结构性文案，未知文本和许可证正文继续返回英文原文。

**Tech Stack:** React 19、TypeScript 5.9、Next.js 16、Vitest 4、现有 `PublicSiteLocaleCode` 路由与静态国际站构建。

## Global Constraints

- 仅修改国际站 `/es/privacy-policy/`、`/es/cookie-policy/`、`/es/terms-of-service/`、`/es/open-source-licenses/` 的西语呈现。
- 不修改国内站以及英文、简体中文、繁体中文、印尼语法务正文。
- 不修改 `frontend/src/content/legal/terms-of-service.txt`、`frontend/src/content/legal/open-source-licenses.txt`、图片或其他静态资源。
- 公司主体、地址、邮箱、生效日期、Cookie 技术标识、软件名称和许可证名称保持源文一致。
- 西语效力说明固定为：`En caso de discrepancia o incoherencia entre la versión en inglés y esta traducción al español, prevalecerá la versión en inglés, salvo que la legislación aplicable disponga lo contrario.`
- `git commit`、`git push` 和 MR 必须在展示最终 diff 与验证证据后另行获得用户确认。

---

### Task 1: 建立西语法务正文与许可证边界测试

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/legal-page-routing.test.ts`
- Modify: `frontend/src/pages/marketing/privacy-policy-page.tsx`
- Modify: `frontend/src/pages/marketing/cookie-policy-page.tsx`
- Modify: `frontend/src/pages/marketing/terms-of-service-page.tsx`

**Interfaces:**
- Produces: `getPrivacyPolicyCopy(locale)`、`getCookiePolicyCopy(locale)`、`getTermsOfServiceBlocks(locale, englishBlocks)`，供页面和测试共享语言选择逻辑。
- Consumes: 现有 `PublicSiteLocaleCode`、`PolicyCopy`、`CookiePolicyCopy`、`TermsBlock`。

- [x] **Step 1: 先修改测试，锁定西语正文、效力说明和开源原文边界。**

  测试应导入三个选择函数，并至少断言：

  ```ts
  const disclaimer =
    'En caso de discrepancia o incoherencia entre la versión en inglés y esta traducción al español, prevalecerá la versión en inglés, salvo que la legislación aplicable disponga lo contrario.';

  expect(getPrivacyPolicyCopy('es')).toMatchObject({
    title: 'Política de privacidad',
    languageTitle: '10. Idioma',
    languageParagraph: disclaimer,
  });
  expect(getCookiePolicyCopy('es').sections.at(-1)).toEqual({
    title: '7. IDIOMA',
    paragraphs: [disclaimer],
  });
  expect(getTermsOfServiceBlocks('es', [])).toEqual(
    expect.arrayContaining([
      { kind: 'h2', text: 'Idioma' },
      { kind: 'paragraph', text: disclaimer },
    ]),
  );
  ```

  同一测试继续断言 `translateNoticeText('Terms of the Apache License 2.0:', 'es')` 返回西语分组标题，而 MIT/Apache 正文样本保持英文。

- [x] **Step 2: 运行焦点测试并确认 RED。**

  ```bash
  cd frontend
  pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/legal-page-routing.test.ts
  ```

  Expected: FAIL，原因是选择函数或西语正文尚不存在，而不是解析或测试环境错误。

- [x] **Step 3: 添加最小语言选择函数并让现有语言行为保持不变。**

  选择逻辑固定为：

  ```ts
  export function getCookiePolicyCopy(locale: PublicSiteLocaleCode | null): CookiePolicyCopy {
    if (locale === PUBLIC_SITE_LOCALES.ES) return es;
    if (locale === PUBLIC_SITE_LOCALES.ID_ID) return id;
    return isZhLocale(locale ?? undefined) ? zh : en;
  }
  ```

  隐私政策和服务条款使用同样的 locale 优先级；页面组件改为消费选择函数，避免测试和渲染逻辑漂移。

---

### Task 2: 完成隐私政策西语正文

**Files:**
- Modify: `frontend/src/pages/marketing/privacy-policy-page.tsx`
- Test: `frontend/src/pages/marketing/__tests__/legal-page-routing.test.ts`

**Interfaces:**
- Consumes: `PolicyCopy`、`sectionFour`、`getPrivacyPolicyChrome()`。
- Produces: 与 `en`、`zh`、`id` 同构的 `es: PolicyCopy` 和 `sectionFour.es`。

- [x] **Step 1: 新增完整 `es: PolicyCopy`。**

  西语对象必须覆盖 `PolicyCopy` 的全部字段和 1–10 节，包含：

  ```ts
  languageTitle: '10. Idioma',
  languageParagraph:
    'En caso de discrepancia o incoherencia entre la versión en inglés y esta traducción al español, prevalecerá la versión en inglés, salvo que la legislación aplicable disponga lo contrario.',
  ```

  表格行数、权利清单、保留期限、第三方链接和联系邮箱须与英文对象一一对应；`sectionFour.es` 提供第 4 节两段完整西语正文。

- [x] **Step 2: 切换页面选择逻辑并移除英文 fallback 提示。**

  `getPrivacyPolicyCopy('es')` 返回西语对象，安全章节也选择 `sectionFour.es`；删除页头 `El contenido legal de esta página se ofrece en inglés.`，因为正文已完整本地化。

- [x] **Step 3: 运行焦点测试。**

  ```bash
  cd frontend
  pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/legal-page-routing.test.ts
  ```

  Expected: 隐私政策西语断言 PASS；其他尚未实现的西语法务断言仍按当前任务进度失败。

---

### Task 3: 完成 Cookie 政策西语正文

**Files:**
- Modify: `frontend/src/pages/marketing/cookie-policy-page.tsx`
- Test: `frontend/src/pages/marketing/__tests__/legal-page-routing.test.ts`

**Interfaces:**
- Consumes: `CookiePolicyCopy`、`renderInlineLinks()`、`browserLinks`。
- Produces: 与英文对象同构的 `es: CookiePolicyCopy` 及西语可点击链接 token。

- [x] **Step 1: 新增完整 `es: CookiePolicyCopy`。**

  保持 Cookie 名称、域名和 URL 原样；翻译标题、说明、用途和期限。对象最后一节固定为：

  ```ts
  {
    title: '7. IDIOMA',
    paragraphs: [
      'En caso de discrepancia o incoherencia entre la versión en inglés y esta traducción al español, prevalecerá la versión en inglés, salvo que la legislación aplicable disponga lo contrario.',
    ],
  }
  ```

- [x] **Step 2: 补齐西语链接 token 并移除英文 fallback 提示。**

  `browserLinks` 与 `tokenPattern` 加入西语 Chrome、Safari、Internet Explorer、Firefox 链接文案；`aquí` 继续链接联系邮箱，Google Analytics 扩展文案继续链接原官方 URL。

- [x] **Step 3: 运行焦点测试并确认 Cookie 断言 GREEN。**

  ```bash
  cd frontend
  pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/legal-page-routing.test.ts
  ```

---

### Task 4: 完成服务条款西语正文

**Files:**
- Modify: `frontend/src/pages/marketing/terms-of-service-page.tsx`
- Test: `frontend/src/pages/marketing/__tests__/legal-page-routing.test.ts`

**Interfaces:**
- Consumes: `TermsBlock`、`parseTermsBlocks()`、`localizedLightVelaUrl()`。
- Produces: `esTermsBlocks` 和 `getTermsOfServiceBlocks()`。

- [x] **Step 1: 新增与印尼语块序列同构的 `esTermsBlocks`。**

  必须覆盖引言、资格、附加条款、定义、账户、服务、第三方服务、订阅付款、用户义务、知识产权、隐私、终止、免责声明、赔偿、责任限制、争议解决、一般条款、联系信息及司法辖区附录。最后追加：

  ```ts
  { kind: 'h2', text: 'Idioma' },
  {
    kind: 'paragraph',
    text: 'En caso de discrepancia o incoherencia entre la versión en inglés y esta traducción al español, prevalecerá la versión en inglés, salvo que la legislación aplicable disponga lo contrario.',
  },
  ```

- [x] **Step 2: 改用统一选择函数并更新西语页头说明。**

  ```ts
  export function getTermsOfServiceBlocks(
    locale: PublicSiteLocaleCode,
    englishBlocks: TermsBlock[],
  ): TermsBlock[] {
    if (locale === PUBLIC_SITE_LOCALES.ES) return esTermsBlocks;
    if (locale === PUBLIC_SITE_LOCALES.ID_ID) return idTermsBlocks;
    return isZhLocale(locale) ? zhTermsBlocks : englishBlocks;
  }
  ```

  西语 `note` 改为说明该页面是官方服务条款的西语译本，不再声称正文仅提供英文。

- [x] **Step 3: 运行焦点测试并确认前三份正文全部 GREEN。**

  ```bash
  cd frontend
  pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/legal-page-routing.test.ts
  ```

---

### Task 5: 完成开源声明结构翻译与全量验证

**Files:**
- Modify: `frontend/src/pages/marketing/open-source-licenses-page.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/legal-page-routing.test.ts`
- Verify: `frontend/src/content/legal/open-source-licenses.txt`
- Verify: `frontend/src/content/legal/terms-of-service.txt`

**Interfaces:**
- Consumes: `noticeBlocks`、`translateNoticeText()`。
- Produces: 西语结构性翻译，未知许可证文本保持原文。

- [x] **Step 1: 翻译解析器识别的西语结构文案。**

  `translateNoticeText()` 对西语处理以下固定模式：

  ```ts
  `Software de código abierto con licencia ${licenseGroup[1]}:`
  `Términos de la ${licenseTerms[1]}:`
  `Puede obtener el código fuente y la información detallada de este componente en ${sourceInfo[1]}.`
  ```

  两段项目致谢/错误反馈通用说明和 `license not found` 同步翻译；其他文本直接返回原文，确保许可证正文不变。

- [x] **Step 2: 更新开源页的西语法律说明。**

  页面说明固定表达：许可证条款保留英文原文，出现差异时以英文原文为准。不得把 MIT、Apache 或其他许可证全文翻译为西语。

- [x] **Step 3: 运行法务焦点测试和相关路由回归。**

  ```bash
  cd frontend
  pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/legal-page-routing.test.ts \
    next-site/__tests__/search-routing.test.ts
  ```

  Expected: 全部 PASS；四个法务首页链接和内部链接保持 `/es/`。

- [x] **Step 4: 运行静态与国际站构建门禁。**

  ```bash
  cd frontend
  pnpm i18n:check
  pnpm check
  pnpm build:global
  cd ..
  git diff --check
  git diff --exit-code -- frontend/src/content/legal/terms-of-service.txt frontend/src/content/legal/open-source-licenses.txt frontend/public frontend/src/content/docs/images
  ```

  Expected: i18n、类型、国际站静态构建和 diff 检查通过；法务英文源文件及图片目录零改动。

- [x] **Step 5: 在本地国际站逐页进行浏览器 smoke。**

  检查：

  ```text
  http://localhost:5174/es/privacy-policy/
  http://localhost:5174/es/cookie-policy/
  http://localhost:5174/es/terms-of-service/
  http://localhost:5174/es/open-source-licenses/
  ```

  Expected: 前三页为完整西语正文且末尾显示英文版本优先说明；开源声明结构为西语、许可证正文为英文；长段落、表格、链接和移动宽度无明显布局问题。

- [x] **Step 6: 展示最终 diff、验证证据和建议提交信息，等待用户确认。**
