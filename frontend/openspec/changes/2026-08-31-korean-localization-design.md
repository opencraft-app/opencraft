# 国际站韩语完整本地化设计

## 目标

在国际站完整交付 `ko-KR` / `/ko-kr`，范围与当前日语实现及最新英文内容保持一致：公开站、控制台宿主、UI 字典、结构化内容、62 篇 Docs、法务页面、SEO、路由与字体。首轮通过本地显式预览联调；浏览器高可见文案修正和专项门禁通过后，与日语一并开放生产发布标记。

## 当前事实

- locale 注册表已包含 `ko-KR` / `ko-kr`，但 `switcherVisible` 与 `translationRequired` 均为 `false`。
- `ko-KR.json` 与中文基准同为 2680 个 key，仅 17 条非空，仍缺 2663 条。
- 英文与日语 Docs 当前均为 62 个 Markdown 文件，韩语 Docs 源、搜索路由和 manifest 尚不存在。
- SEO 基础映射已识别 `ko-KR`，但页面级韩语 title/description、旧运行时 SEO 解析和真实发布路由尚未完整接通。
- Soul、Buddy、Skills、Experts 与场景任务等结构化内容已有日语模块，可复用相同 resolver 模式增加韩语真源。
- 韩文字形不进入现有 HY 字体子集，必须使用系统字体回退。

## 范围

### 包含

- 2680 条 hash UI 字典完整韩语译文，并保护占位符、HTML、命令、品牌和换行结构。
- Soul、人设测试、curated Skills、Experts、场景任务等代码可控结构化内容。
- 与 `src/content/docs/en/**` 等集的 62 篇韩语 Docs、搜索端点、路由 manifest 和内部链接。
- Privacy、Cookie、Terms 的完整韩语译文；开源许可证正文继续保留英文。
- `/ko-kr/**` 的 title/description、canonical、hreflang、sitemap、OG、JSON-LD 与 `html lang="ko-KR"`。
- 韩语系统字体、桌面/移动端语言切换器与国内站负向回归。

### 不包含

- 国内站用户可见变化。
- Models 与 Tea SDK 内嵌语言包。
- 自动语言识别、账号级语言同步或韩国市场支付/登录/套餐调整。
- 不经自动化专项门禁或仍存在已知高可见误译时打开生产发布标记。

## 采用方案

采用“复用日语模块化管线 + 韩语独立内容源 + 注册表统一发布”。locale 注册表继续作为发布真源；普通 UI 使用完整 `ko-KR` 字典；结构化内容、法务和 SEO 使用显式韩语模块；Docs 使用 `src/content/docs/ko/**` 独立源。`NEXT_PUBLIC_PREVIEW_LOCALES=ja-JP,ko-KR` 仅用于发布标记打开前的非生产联调，正式入口由注册表双标记控制。

不采用以下方案：

- UI 先行、Docs/法务后补：会产生用户可到达的半成品语言站。
- 韩语路由回退英文：无法满足完整本地化，也会掩盖第一方缺失。
- 只开放预览、不开放生产标记：无法满足用户明确提出的日韩切换入口需求。

## 术语与语气

| 概念 | 韩语 |
| --- | --- |
| Agent | 에이전트 |
| Hermes Agent | Hermes Agent |
| Skill / Skills | 스킬 |
| Automation | 자동 작업 |
| Channel | 채널 |
| Memory | 메모리 |
| Persona | 페르소나 |
| Model | 모델 |
| Provider | 프로바이더 |

面向用户的产品文案使用自然、简洁的敬语体；品牌、模型、协议、命令、文件名、代码和模板变量保持原文。

## 内容与路由设计

### UI 与结构化内容

以 `en-US.json` 为语义底稿、`zh-CN.json` 与 `zh-to-key.json` 为 key/原文事实源。所有发布语种完整性测试要求 0 空值、占位符一致、无翻译提示残留。结构化内容使用 locale record/resolver，发布后的 `ko-KR` 不得静默回退中文或日语；外部 API 不支持韩语时可以显式请求英文，但第一方 UI 必须为韩语。

### Docs

以最新 `src/content/docs/en/**` 为真源，在 `src/content/docs/ko/**` 保持 62/62 文件等集。标题层级、代码块、表格、图片目标和事实数据保持一致；第一方内部链接使用 `/ko-kr/docs/**`。同步脚本、Fumadocs 翻译、面包屑、更新时间、搜索端点和 manifest 全部显式接入 `ko-kr`。

### 法务

Privacy、Cookie 与 Terms 保持英文正式结构等长，并加入英文版本优先声明：

> 영문 버전과 본 한국어 번역본 간에 모순 또는 불일치가 있는 경우, 관련 법령에 별도 규정이 없는 한 영문 버전이 우선합니다.

开源许可证正文不翻译，只翻译页面结构和说明。Privacy、Cookie、Terms 沿用西语模式：提供本地化译文，并明确发生歧义时以英文版本为准；用户安排的母语与法务复核作为后续人工质量保障。

### SEO

韩语页使用 self-canonical、`hreflang="ko-KR"`、`og:locale="ko_KR"`、`html lang="ko-KR"`。自然覆盖 LightVela、클라우드 AI 에이전트、개인 AI 에이전트、AI 어시스턴트、Hermes Agent、상시 실행、장기 메모리、자동 작업、스킬，不做关键词堆砌。仅真实生成并返回 200 的路径进入 sitemap/hreflang。

### 字体与性能

韩语使用 `Apple SD Gothic Neo`, `Malgun Gothic`, `Noto Sans KR`, system-ui 回退，不引入完整韩文 WebFont，也不进入 HY 字体子集。沿用日语完成的 locale 分包，避免把韩语字典加入非韩语首屏。

## 错误、回滚与验收

- 字典缺失、占位符或结构漂移由 i18n 测试阻断。
- Docs 文件、图片、代码块、标题、表格、slug 或内链漂移由 parity 阻断。
- canonical/hreflang/OG/lang/sitemap 不一致由 SEO 与构建测试阻断。
- 结构化内容中文串用或错误 fallback 由专项 resolver 测试阻断。
- 母语或法务审阅未完成时保持注册表双标记关闭；回滚只需关闭韩语标记，不影响其他 locale。

完成定义：2680/2680 字典非空；62 篇 Docs 与英文等集；公开、法务、Agent 核心路径可达且为韩语；国际站生产构建生成 `/ja-jp/**` 与 `/ko-kr/**` 并展示两个切换入口；国内构建不生成日韩页面；专项自动门禁与浏览器验收通过。
