# 【产品需求】【LightVela】【双站】注册到开通转化引导优化

## 来源
- 需求来源：想法输入（数据观察 + 转化优化诉求）
- 相关分支：`registrationguide-78`
- 提出人/干系人：产品（jasminzhao）
- 相关代码：`frontend/src/pages/marketing/landing-page.tsx`、`frontend/next-site/subscribe-page.tsx`、`frontend/src/app/(site)/page.next.tsx`、`frontend/src/app/(site)/[lang]/page.next.tsx`、`frontend/src/app/layout.next.tsx`

## 背景与问题
- 当前用户怎么做：新用户从首页进入，通过 Hero 主 CTA 或订阅页套餐卡进入注册/开通链路。
- 现在卡在哪里：站点数据观察到「注册量 → 开通套餐量」转化漏斗流失过大，从注册到开通的转化率偏低。
- 为什么现在要做：通过强化"免费"心智、优化 CTA 文案引导，降低用户对"开通=付费"的顾虑，提升注册到开通的转化。同时顺带修复首页 SEO title 后缀展示问题。

## 目标用户与场景
- 目标用户：新用户（未开通套餐状态，`isSubscribed === false`，含未登录用户）。
- 典型场景：新用户首次访问首页 / 浏览套餐页，处于"是否开通"的决策节点。
- 频率和重要性：首页与套餐页是核心转化入口，直接影响北极星转化指标，重要性高。

## 目标
- 用户结果：新用户更清晰地感知"可免费开始"，降低开通决策门槛。
- 产品结果：提升「注册 → 开通套餐」转化率，收窄转化漏斗流失。
- 不做会怎样：转化漏斗持续偏大，注册用户流失率维持高位。

## 范围
- 本次包含：
  1. **首页 Hero 主 CTA 文案优化**：当用户未开通套餐（`!isSubscribed`）时，Hero 主按钮文案由"立即创建"改为"免费试用 / Free Trial"。
  2. **订阅页基础版套餐按钮文案优化**：套餐页第一张主推卡（启航 Launch，`index===0` / featured）在用户未开通套餐时，主按钮文案由"立即开通"改为"免费开通 / Get Started Free"。
  3. **首页 title 后缀修复**：首页 title 去掉 `| LightVela` 后缀（当前 root layout 使用 `template: '%s | LightVela'`，首页需通过 `title.absolute` 跳过模板）。
- 本次不包含：
  - 按钮点击后的跳转/行为逻辑变更（仅文案层调整，行为保持不变）。
  - 其他套餐卡（巡游 Cruise / 远航 Voyage / AI 增强版）的文案调整。
  - 已开通套餐用户的文案（维持现有逻辑不变）。
  - 除首页外其他页面的 title 后缀（其余页面继续保留 `| LightVela` 后缀）。
- 已知依赖：
  - `useOpenClaw().isSubscribed`（是否已开通套餐）、`useSession().isAuthenticated`（是否已登录）已可用。
  - i18n 采用"中文即 key"方案，需在 `zh-CN.json` / `en-US.json` 补齐对应翻译。

## 发布站点与同步策略
- 发布范围：**双站同步**（国内站 lightvela.com + 国际站 lightvela.ai）
- 国际站是否同步：是
- 国内站是否同步：是
- 差异化原因：仅语言/i18n 文案差异，用户价值、交互、行为完全一致。
  - 中文（zh-CN）："免费试用"、"免费开通"
  - 英文（en-US）："Free Trial"、"Get Started Free"
- 路由与内容影响：首页 `/`、多语言首页 `/[lang]`、订阅页 `/subscribe`；影响 Hero CTA 文案、套餐卡按钮文案、首页 title/metadata。
- 上线顺序：同步上线（双站一并发布）。

## LightVela 影响面
- 前端页面/路由：首页 `landing-page.tsx` + `imports/Frame2147230025/sections/HeroSection.tsx`；订阅页 `next-site/subscribe-page.tsx`；首页 metadata `app/(site)/page.next.tsx`、`app/(site)/[lang]/page.next.tsx`、`app/layout.next.tsx`。
- Hermes/OpenClaw/运行时：无（不改运行时行为）。
- SkillHub/MCP/工具：无。
- SDK/文档/运营：i18n 文案（`src/i18n/generated/zh-CN.json`、`en-US.json`）需更新；SEO 校验脚本 `scripts/check-next-seo.mjs` 需通过。
- 权限/安全/数据：无权限/数据变更；埋点建议区分新文案曝光与点击（见发布与观测）。

## 方案
- 交互或流程：
  - 首页 Hero：读取 `isSubscribed`，`!isSubscribed` 时 `ctaLabel = t("免费试用")`；已开通维持现有逻辑（`showAgentPartnerLabel ? t("我的智能体伙伴") : t("立即创建")`）。
  - 订阅页启航 Launch 卡：`index===0` 且当前用户 `!isSubscribed` 时，`ctaLabel = t("免费开通")`；已开通用户维持原 `t("立即开通")`（及售罄/询价/暂无报价等既有分支）。
  - 首页 title：让首页 metadata 返回 `title: { absolute: '<品牌标题>' }`，跳过 root 的 `%s | LightVela` 模板，确保首页 title 无后缀。
- 状态变化：仅按钮文案随 `isSubscribed` 状态切换，无新增业务状态。
- 数据或接口：无接口变更。
- 异常和空态：`isSubscribed` 状态未就绪（加载中）时，按现有兜底逻辑显示默认文案，避免闪烁；不新增空态。

## 验收标准
- 验收 1（首页 Hero）：未开通套餐用户（含未登录）访问首页，Hero 主按钮显示"免费试用"（zh-CN）/"Free Trial"（en-US）；已开通用户文案维持不变；点击行为与改动前一致。
- 验收 2（订阅页基础版）：未开通套餐用户访问订阅页，启航 Launch 卡主按钮显示"免费开通"（zh-CN）/"Get Started Free"（en-US）；已开通用户及其他套餐卡文案维持不变；点击行为与改动前一致。
- 验收 3（首页 title）：国内站首页 title 无 `| LightVela` 后缀且不重复品牌名；国际站首页同样无后缀；其余页面 title 仍保留 `| LightVela` 后缀；`check-next-seo.mjs` 校验通过。
- 验收 4（双站一致）：国内站与国际站在对应语言下文案正确、行为一致。

## 发布与观测
- 灰度/开关：可随常规前端发布上线；如需可用现有灰度机制先灰度国内站再国际站（默认同步上线）。
- 日志/埋点/指标：核心指标为「注册 → 开通套餐」转化率；建议保留/复用 Hero CTA（`handleCreateClick('hero')`）与订阅按钮点击埋点，观察文案调整前后曝光→点击→开通转化变化。
- 回滚：纯文案 + metadata 改动，回滚风险低，前端回退版本即可恢复。

## 待确认问题
- 无（范围、文案、展示条件均已确认）。

---

### 确认记录
- 基础版指向：第一张主推卡（启航 Launch）。
- 英文文案：Hero = Free Trial；基础版 = Get Started Free。
- 展示条件：仅对未开通套餐的新用户显示新文案，已开通用户维持原文案。
