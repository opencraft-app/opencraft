# 国际站西语端到端上线 Spec

**最后更新：** 2026-08-24

**区域：** `global`，仅国际站 `lightvela.ai`。

**Locale：** `es`；公开 URL 前缀 `/es`；日语与韩语继续隐藏。

## 1. 区域隔离

1. 国内/国际差异继续由 `isCN` / `isGlobal` 编译期常量决定，不得用 locale 值代替区域判断。
2. 国内站不展示 `es`，不增加 `/es` 本站入口，不改变默认中文、现有跨站跳转或既有选项顺序。
3. 国际站才读取注册表中的 `switcherVisible` locale 生成语言选项。
4. 共享 locale 类型可以包含 `es`，但任何用户可见入口必须同时满足国际站区域条件。
5. `ja-JP`、`ko-KR` 保持 `switcherVisible: false` 和 `translationRequired: false`。

## 2. Locale 注册表与开放门禁

`frontend/src/i18n/locales.json` 是运行时数据真源，`locales.config.ts` 提供静态类型与派生 helper。

西语定义必须满足：

- `code: "es"`
- `urlLang: "es"`
- `htmlLang: "es"`
- `docsSourcePrefix: "es"`
- `docsFallbackPrefixes: ["en", "global"]`，且优先回退英文
- `seoPrefixed: true`
- `requiresFontFallback: true`

开发期间开关保持关闭。下列条件已满足，因此最终发布状态设置为：

- `switcherVisible: true`
- `translationRequired: true`

已完成条件包括：字典 key 集一致、必填翻译清零、结构校验通过、路由/SEO/文档/字体定向测试通过。国际站和国内站构建及浏览器 smoke 仍作为 Task 8 最终验收门禁，失败时回滚西语入口。

## 3. 西语字典与翻译

### 3.1 基线同步

1. 以当前 `zh-CN.json` 与 `zh-to-key.json` 为中文事实源。
2. 西语字典必须删除中文基准已移除的 key，并补入所有新增 key。
3. 新 key 初始为空，随后通过中文原文映射写入西语；不得根据 hash 猜测原文。
4. 日语、韩语只允许做保持 key 集一致所必需的机械同步，不进行翻译或开放。

### 3.2 翻译规则

- 使用自然、简洁的拉美西语；不用西班牙本土特有的 `vosotros` 表达。
- LightVela、Hermes Agent、Agent、Skills、SkillHub、ClawHub、模型名、渠道品牌名、命令和代码标识按产品术语保留。
- 按钮和状态文案优先使用短语；错误文案说明原因与下一步。
- `{{variable}}` 集合必须与中文原文完全一致。
- HTML 标签数量、嵌套意图和换行结构必须保持。
- 仅由字符串拼接需要的前后空白可以保留，并由校验器输出可审计告警。
- 同一中文原文在不同位置共用同一 hash 翻译，不为上下文差异复制新 key。

### 3.3 校验

- `i18n:check`：西语启用后待翻译必须为 0。
- `i18n:validate`：错误必须为 0；告警逐项确认，不用关闭规则隐藏问题。
- 字典测试：key 集与中文基准双向一致。

## 4. 语言切换与路由

1. 国际站语言选项由 `SWITCHER_VISIBLE_LOCALES` / locale definitions 生成，不再维护逐语种常量与三元链。
2. 公开 SEO 路径从其他语言切换到西语时使用 `/es/<bare-path>`。
3. 从 `/es/...` 切换回英文时移除 locale 前缀；切换到其他既有语言沿用其规范前缀。
4. 控制台路径保持当前 URL 结构，只更新 `lw-locale` 并沿用既有 reload 规则。
5. 非法或历史 locale 值必须经注册表白名单解析后回退区域默认语言。
6. URL prefix matcher 按长度降序，避免未来 `es-ES` 被 `es` 抢先匹配。
7. 页头、页脚、法律入口和公开站导航不得通过排除式判断把 `es` 静默映射为英文或中文。

## 5. 文档站

### 5.1 内容范围

- 本次区域固定为 `global`，不修改 `src/content/docs/` 国内站根目录正文。
- 不新增西语正文副本；正文通过 `docsFallbackPrefixes` 回退 `en`。
- 需要西语化的内容仅包括侧栏分组、页面 title/description、搜索索引显示、docs manifest 和页面 metadata。

### 5.2 注册一致性

以下来源必须同时包含 `es` 且互相一致：

- `src/config/docs-sidebar.ts`
- `next-site/docs-route-manifest.ts`
- `scripts/sync-fumadocs-content.mjs`
- docs source / loader 与 localized path helper
- sitemap 和 SEO 数据来源

同一 slug 在西语正文 fallback 后仍必须 canonical 到 `/es/docs/<slug>`，并输出对应语言 alternate。

## 6. SEO 与 metadata

1. 公开页与 docs 页的 title、description、canonical 和 `og:url` 必须指向同一个西语 URL。
2. `html lang` 使用 `es`；Open Graph locale 使用项目验证过的西语 locale 值，不伪造地区版本。
3. `hreflang="es"` 只为真实可访问的西语页面输出。
4. sitemap 必须包含 `/es` 公开页和 `/es/docs/<slug>`；不能为不存在的路径生成条目。
5. 9 个公开 SEO 页面的 `TITLE_BY_LOCALE` / `DESCRIPTION_BY_LOCALE` 继续使用完整 `Record`，补齐自然西语文案，不改成 `Partial`。
6. Open Graph 与 Twitter 图片继续复用稳定的绝对 URL，不因新增 locale 复制资源。
7. 不新增与真实页面内容不一致的 JSON-LD、评分、价格或声明。

## 7. 字体

1. 字体子集采集源必须遍历全部注册字典，补上既有遗漏的 `id-ID`。
2. `áéíóúüÁÉÍÓÚÜ` 若源字体已有字形，必须纳入 subset。
3. `ñÑ¿¡` 在现有标题字体源无字形时，不把它误报为 subset 漏采集；西语 locale 使用可覆盖这些字符的系统拉丁字体回退。
4. 字体回退只按西语 locale 生效，不改变国内站中文标题字体。
5. 构建校验分别报告“源字体缺字”和“subset 漏字”，避免错误修复方向。

## 8. 国际站 UI 覆盖

西语覆盖对象包括：首页、价格、支持、更新日志、页头、页脚、法律入口的 UI 文案，以及登录、账户、订阅和 Agent 控制台宿主自有的通道、自动任务、Soul/人设、Skills、场景任务、通知文案。

明确排除 `@tencent/tea-sdk-lightclaw` 内部渲染文案、Models 模块整体本地化和法务正文内容。

## 9. 错误处理与降级

- 未知 locale：回退国际站英文，不允许回退中文。
- 西语字典 key 缺失：开发/CI 阶段失败；开放后不依赖静默 fallback 掩盖。
- 文档正文缺西语源：稳定回退英文；导航和 metadata 不回退英文。
- 字体源缺字：使用 locale 字体回退；subset 采集遗漏则构建失败。
- 西语入口出现问题：将 `switcherVisible` 设回 `false` 可隐藏入口，不影响其他语言。

## 10. 测试与验证

### 10.1 自动测试

- locale 注册表数据/类型双向一致、前缀排序与白名单解析。
- 西语字典 key 集、必填翻译、占位符、HTML 与换行结构。
- 国际站语言切换器展示西语、路由切换、持久化与 reload 行为。
- 国内站不展示西语的负向测试。
- 公开页导航、页头、页脚及控制台 locale 映射测试。
- docs sidebar、slug、manifest、搜索和 fallback parity 测试。
- sitemap、canonical、hreflang、`html lang` 与 metadata 一致性测试。
- 字体字符覆盖与西语 fallback 测试。

### 10.2 构建门禁

- `pnpm i18n:check`
- `pnpm i18n:validate`
- 相关 Vitest 与最终全量 `pnpm test`
- `pnpm check`
- `NEXT_PUBLIC_REGION=global VITE_REGION=global pnpm build`
- `NEXT_PUBLIC_REGION=cn VITE_REGION=cn pnpm build`
- `git diff --check`

### 10.3 浏览器验收

国际站至少验证 `/es`、`/es/subscribe`、`/es/support`、`/es/changelog`、`/es/docs/overview`，以及一个控制台页面的西语切换与刷新保持。

检查导航、正文关键路径、无缺字、无横向溢出、无错误浮层、canonical/hreflang 和 `html lang`。国内站只做负向 smoke：不出现西语入口，默认中文和既有导航不变。

## 11. 完成定义

1. 西语入口开放，日语和韩语仍隐藏。
2. 西语字典翻译与结构门禁清零。
3. 国际站公开页、控制台宿主、docs 导航/metadata、SEO 和字体验收通过。
4. 国内站自动测试与构建回归通过。
5. 未处理项只允许是本 Spec 明确排除的 SDK、Models、法务正文和文档正文翻译。
6. 输出验收摘要并等待用户确认；确认前不归档、不 commit、不 push、不创建 MR。
