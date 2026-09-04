# LightVela 首页文案、DeepSeek Harness 与国际站 Blog 视觉优化

## 基本信息
- 当前产品：LightVela
- 需求单状态：已确认，按用户要求由原第 2 / 3 / 4 项合并
- 创建人：Keria / Codex
- 创建日期 / 最后更新时间：2026-09-04 / 2026-09-05

## 需求背景
本次需求来自同一轮官网体验走查，核心问题集中在首页对外口径和国际站内容页观感：

- 国内站与国际站首页的免费体验权益表达需要差异化：国际站 AI Token 套餐免费体验从 3 天调整为 7 天；国内站仍保持 3 天，但主 CTA 需要强化“免费体验，10秒极速开通”。
- 国际站英文首页中 “working partner” 会把 LightVela 过度限制在工作场景，需要统一为 AI companion / AI 伙伴语境，多语言也需要避免只表达成工作助手。
- 国内站和国际站首页 DeepSeek Harness 模块截图偏模糊，影响用户理解 Labs 新能力。
- 国际站 `lightvela.ai/blog/` 的旧蓝色背景和深色封面与新版首页不搭，需要调整为更清爽、接近首页的白底轻质感。

不处理会导致双站权益口径不一致、品牌定位变窄、重点功能截图可信度不足，以及国际站用户从首页进入 Blog 后产生明显视觉落差。

## 目标用户与场景
- 目标用户画像：
  - 国际站新用户：通过 `lightvela.ai` 了解套餐权益、AI companion 定位和产品内容。
  - 国内站新用户：通过 `lightvela.com` 了解免费体验和快速部署路径。
  - 产品、运营、市场和 QA：需要统一双站首页权益、定位、截图与内容页视觉口径。
- 典型场景：
  - 用户在首页 CTA 区域查看免费体验权益。
  - 用户在首页介绍区理解 LightVela 是长期在线、持续学习的 AI 伙伴。
  - 用户滚动到 DeepSeek Harness 模块，通过截图判断产品能力和页面细节。
  - 国际站用户从首页或导航进入 Blog，浏览产品动态和使用案例。

## 目标
- 产品结果：
  - 国际站 AI Token 套餐免费体验统一展示为 7 天，国内站仍展示 3 天。
  - 国内站首页主 CTA 展示“免费体验，10秒极速开通”。
  - 英文和多语言首页定位统一为 AI companion / AI 伙伴，不限定为工作伙伴。
  - DeepSeek Harness 首页展示图在国内站和国际站各 locale 下清晰可辨。
  - 国际站 Blog 列表页与新版首页视觉一致，白底、轻竖线、浅色封面和独立文章卡片。
- 业务目标：减少权益误解，增强品牌定位一致性，提升官网核心功能和内容入口的专业感。

## 范围
- 本次包含：
  - 国际站默认英文、`en-US` 及已发布 locale 首页：AI Token plan free 从 3 days 改为 7 days。
  - 国内站 `zh-CN` 首页：主 CTA 改为“免费体验，10秒极速开通”，并保留“AI Token 套餐免费体验 3 天”。
  - 首页英文 “Then I become your best working partner” 改为 “Then I become your AI companion”，多语言同步调整为 AI companion / AI 伙伴语境。
  - 国内站和国际站所有 locale 的 DeepSeek Harness 首页展示图替换为更高清版本，并更新图片缓存版本参数。
  - 国际站 Blog 列表页移除旧蓝色背景，改为白底和首页同体系轻竖线背景层。
  - 国际站 Blog 四篇文章封面替换为白底浅色版本，保留原封面主体关系。
  - 国际站 Blog 不改变原文章列表排版和信息结构，仅为不同文章增加白底、浅灰边线、灰色轻阴影的独立卡片边界。
  - 国际站 Blog 和文章页底部 footer 调整为与首页一致的 compact legal footer。
  - 检查国内站是否开放 Blog 路由。
- 本次不包含：
  - 不改套餐真实计费逻辑、订阅 API、支付流程或权益发放规则。
  - 不改订阅页价格表、订单确认页和真实优惠策略。
  - 不新增国内站 Blog 入口，不新增国内站 Blog 内容页。
  - 不改 Blog 文章正文结构、SEO 文案、sitemap 逻辑和文章数量。
  - 不改 DeepSeek Harness 控制台真实功能、安装流程、模型配置逻辑或后端接口。
  - 不重做首页导航、价格页、Docs 或 Changelog。
- 优先级：P0
- 已知依赖：首页静态 fragment、Next 国际站 Blog 路由、`BLOG_POSTS` 内容数据、`frontend/public/lightvela-intl-home/assets/` 和 `frontend/public/assets/blog/` 静态资源。

## 功能详细描述
- 首页免费体验与定位文案：
  - 国际站英文：`Try an AI token plan free for 7 days.`
  - 国际站简中：`AI Token 套餐免费体验 7 天`
  - 国际站繁中：`AI Token 套餐免費體驗 7 天`
  - 印尼语、西语、日语、韩语同步改为 7 天口径。
  - 国内站简中：`免费体验，10秒极速开通` + `AI Token 套餐免费体验 3 天`。
  - 英文定位：`Then I become your AI companion`；其他语言使用对应 AI companion / AI 伙伴表达。
- DeepSeek Harness 首页图：
  - 重新导出 `deepseek-harness-*.webp` 为更清晰版本。
  - 所有语言 fragment 继续引用自身 locale 对应图片。
  - 图片引用统一带 `v=20260904-harness-sharp` 缓存版本参数。
- 国际站 Blog 列表页：
  - 页面主背景保持白色，不再使用明显蓝色渐变或额外绿色光影。
  - 顶部背景加入轻量竖向纹理，与首页视觉体系保持一致。
  - 保持原 Blog 列表三列排版节奏，平板两列，移动端单列。
  - 四篇文章使用白底浅色封面，不回到深蓝、反色或多彩背景。
  - 不同文章之间通过轻量卡片区分：白底、浅灰边框、灰色默认阴影、8px 以内圆角。
  - 标题、分类、日期保留原信息层级，不新增作者、不新增摘要。
- 国内站 Blog 检查：
  - 代码中 `/blog` 与多语言 `/[lang]/blog` 均在 `!isGlobal` 时 `notFound()`，国内站当前不开放 Blog。
- 交互说明：
  - 首页 CTA 链接、按钮行为保持不变。
  - Blog 分类切换、文章跳转保持不变。
  - DeepSeek Harness 模块的点击、悬停和 tab 行为保持不变。
- 边界条件与异常处理：
  - 国际站所有已发布 locale 必须同步 7 天，避免同一站点多语言权益不一致。
  - 国内站不能误改成 7 天。
  - 不允许出现 `best working partner` 或等价工作限定语境。
  - 如果某个 locale 暂无专属 DeepSeek Harness 截图，必须明确复用同语言族图片，不允许破图。
  - Blog 封面作为列表装饰图保持空 alt，文章顶部封面继续使用文章已有 alt 文案。
- 数据埋点需求：无新增埋点。

## 发布站点与同步策略
- 发布范围：分阶段 / 混合范围
- 国际站是否同步：是，包含首页文案、DeepSeek Harness 高清图、Blog 视觉改版。
- 国内站是否同步：部分同步，包含首页 CTA 文案和 DeepSeek Harness 高清图；不包含 Blog 视觉改版。
- 差异化原因：
  - 免费体验权益存在站点差异：国际站 AI Token 7 天，国内站 AI Token 3 天。
  - Blog 当前只在国际站开放，国内站没有 `/blog` 入口和页面。
  - DeepSeek Harness 截图清晰度属于双站共性问题，需要双站同步。
- 路由与内容影响：
  - 首页静态 fragment：`/`
  - 国际站 Blog：`/blog/`、国际站本地化 Blog 路由和文章顶部封面
  - 首页 metadata / SEO：AI companion 相关描述
  - 静态图片资源和缓存版本参数
- 上线顺序：可与国内站首页适配同批前端发布；Blog 改动仅在国际站生效。

## LightVela 影响面
- 前端页面/路由：
  - `frontend/public/lightvela-intl-home/index-fragment*.html`
  - `frontend/public/lightvela-intl-home/style.css`
  - `frontend/src/pages/marketing/blog-page.tsx`
  - `frontend/src/pages/marketing/blog-article-page.tsx`
  - `frontend/src/pages/marketing/blog-content.ts`
  - `frontend/src/components/site/legal-footer.tsx`
  - `frontend/next-site/seo.tsx`
- Hermes/OpenClaw/运行时：无新增运行时接口或能力变更。
- SkillHub/MCP/工具：无新增工具能力。
- SDK/文档/运营：运营物料需同步 7 天 / 3 天差异说明；Blog 封面素材需使用新浅底版本。
- 权限/安全/数据：无新增权限、数据采集或后端写入。

## 非功能性需求
- 性能指标：新增封面和高清图保持合理体积，不引入运行时图片请求或未压缩大图。
- 兼容性：沿用现有首页和国际站 Blog 的浏览器兼容性；Blog 桌面三列、平板两列、移动单列。
- 安全与权限：无新增权限或安全要求；静态 fragment 继续禁止不受控脚本和 `javascript:` 链接。
- 国际化 / 无障碍：多语言文案保持完整句；列表封面空 alt，文章页封面保留语义 alt；按钮和文章链接保持可访问。

## 产物交接
- 需要交接的角色/事项负责人：产品、前端、QA、运营/内容、国际化。
- 各方交付物：
  - 产品：确认国内 3 天、国际 7 天权益口径和 AI companion 定位。
  - 前端：实现首页文案、DeepSeek 图片、Blog 视觉和 footer 变更，并补测试。
  - QA：回归国内站首页、国际站首页、国际站 Blog 列表、Blog 文章页和多语言页面。
  - 运营/内容：确认 Blog 封面和首页截图符合对外展示口径。
  - 国际化：复核 AI companion 在各语言中的自然度。
- 输入与依赖：用户提供的 `/start prd` 需求说明、官网截图反馈、Blog 封面方向和 Product Design 参考。
- 时序和上线节点：随 2026-09-04 官网首页与 Blog 调整同批评审。
- 责任人/待确认：套餐真实权益是否需要同步到订阅页、价格页或订单页需另行确认。

## 方案决策
- 采用方案：一个综合 PRD 承接“首页权益与定位文案 + DeepSeek Harness 高清图 + 国际站 Blog 视觉改版”，在同一需求中明确双站差异。
- 选择理由：三项都属于官网用户可见体验优化，且会在同一批前端分支中交付；合并后评审时能统一看首页、截图、Blog 的视觉和文案口径。
- 备选方案与取舍：
  - 三个独立 PRD：边界清晰，但评审和排期容易重复，用户已要求合并。
  - 只保留双站首页 PRD，不写 Blog：会丢失国际站 Blog 的独立验收范围。
  - 把国内站首页 IM 适配也合并进来：范围过大，且国内站首页适配已经是一张单独 PRD，继续单独保留更清楚。
- 延后或不做：订阅页权益同步、国内站 Blog 入口、Blog 正文重排、DeepSeek Harness 真实功能改造、全站品牌语气系统重写。

## 产品原型说明
- 原型结论：不单独输出交互原型。
- 跳过原因：本次属于已有官网页面上的文案、静态图片和视觉局部调整；页面结构、主路径和交互方式沿用现有实现，已通过本地预览和截图走查进行确认。
- 需要设计确认：Blog 四张封面、文章卡片边界和首页截图清晰度。
- 需要前端确认：多语言 fragment、图片路径、缓存参数、Blog 响应式布局和 footer 复用。

## 验收标准
- 验收 1：国际站默认英文和 `en-US` 首页展示 `Try an AI token plan free for 7 days.`，不再出现 3 天 AI Token 文案。
- 验收 2：国际站 `zh-SG`、`zh-Hant`、`id-ID`、`es`、`ja-JP`、`ko-KR` 首页均展示 AI Token 7 天免费体验。
- 验收 3：国内站 `zh-CN` 首页展示 `免费体验，10秒极速开通`，并保留 `AI Token 套餐免费体验 3 天`，不出现 AI Token 7 天免费体验文案。
- 验收 4：英文首页不再出现 `Then I become your best working partner`，多语言同位置不再出现工作伙伴限定语境，统一为 AI companion / AI 伙伴表达。
- 验收 5：国内站 `zh-CN` 与国际站默认英文、`en-US`、`zh-SG`、`zh-Hant`、`id-ID`、`es`、`ja-JP`、`ko-KR` 的 DeepSeek Harness 图片清晰可辨，图片 URL 均带 `v=20260904-harness-sharp`。
- 验收 6：国际站 `/blog/` 不再使用旧蓝色渐变背景或额外绿色光影，页面背景与首页白底、轻竖线一致。
- 验收 7：四篇 Blog 列表封面均为白底浅色版本，不使用深蓝、反色或多彩背景作为列表主图。
- 验收 8：四篇文章保持原 Blog 列表格式，桌面端三列、平板两列、移动端单列；不同文章有独立白色卡片、浅灰边框和灰色轻阴影。
- 验收 9：国际站 Blog 和文章页 footer 与首页 compact legal footer 保持一致，不展示旧底部 mascot 或不一致的底部比例。
- 验收 10：国内站 `/blog` 仍不开放，不新增国内站 Blog 入口。
- 验收 11：相关前端测试、静态检查和类型检查通过。

## 发布与观测
- 灰度/开关：无需新增开关，随前端静态资源发布。
- 日志/埋点/指标：沿用首页 CTA 点击、Blog 文章点击、页面访问和用户反馈观测。
- 回滚：回滚本次前端提交即可恢复旧文案、旧图片和旧 Blog 视觉。

## 待确认问题
- 国际站 AI Token 7 天免费体验是否还需要同步到订阅页、价格页或订单页，本次 PRD 暂按“仅首页文案”处理。
- 后续是否要为国内站新增 Blog 内容入口，需另起产品需求确认。
