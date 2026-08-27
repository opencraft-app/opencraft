# GEO 事实表（内部）

> 状态：**待产品负责人确认**｜建立日期：2026-08-18｜维护目录：`wiki/product-state/`
>
> 本表不对外发布。用途是给「同一个产品事实」指定**唯一负责人**和**唯一最终来源**，
> 消除国内站 / 国际站 / 文档 / 代码之间的事实冲突，为后续 GEO（生成式引擎优化）打地基。
>
> **核心规则：任何对外文案改动，先改「唯一来源」，再由来源同步到镜像位置。禁止直接改镜像。**

---

## 0. 为什么先做这张表

AI 搜索引擎（ChatGPT / Perplexity / 豆包 / Gemini 等）抓取站点后，会对同一问题做**交叉验证**。
一旦发现「LightVela 是内测还是公测」「启航到底 ¥45 还是免费」在同一站点内自相矛盾，
引擎会降低整站可信度，转而引用第三方描述，或者干脆不回答。

当前扫描结论：**站内已存在 5 处 P0 级事实冲突 + 2 处事实缺口 + 3 处机器可读层错误**（见第 2、3、4 节）。
在修掉这些之前，做任何关键词 / 内容扩量都是把矛盾放大。

---

## 1. 主事实表

字段口径：**唯一来源**列写的是「以谁为准」；**镜像位置**列写的是「必须跟随更新的地方」。

### 1.1 当前产品状态

| 项 | 内容 |
|---|---|
| 国内站 | **公测，已开启计费**（2026-08-18 起）✅ 已确认 |
| 国际站 | 维持现状，本轮不改动（文案仍为「计划将于 2026-08-18 转入公测并开启计费」）⏸️ 冻结 |
| 唯一来源 | 订阅后台（`paidBillingEnabled` 计费开关实际状态） |
| 负责人 | ⬜ 待指定 |
| 镜像位置 | `frontend/src/content/docs/01-overview.md:5-11`、`frontend/src/content/docs/announcements/public-beta.md:3,13,33`、`plans.md:113-115`、`contact-us.md`；国际站 `en|global/*` 本轮不动 |
| 冲突 | ✅ **C1 国内站已关闭**（2026-08-18 修复）｜国际站按要求冻结 |

### 1.2 Launch 价格

| 项 | 内容 |
|---|---|
| 国内站 | **月付原价**：启航 ¥45／巡游 ¥95／启航 AI ¥68／巡游 AI ¥158<br>**季付原价**：¥135／¥285／¥204／¥474（＝月付×3）<br>**月付首购价**：启航 ¥0（首单免费 14 天）／巡游 ¥47.50（首月 5 折）／启航 AI ¥40.80（首月 6 折）／巡游 AI ¥94.80（首月 6 折）<br>**季付折后价**：¥114.75／¥242.25（8.5 折）；¥183.60／¥426.60（9 折）<br>✅ 已确认，AI 版**已可售** |
| 国际站 | $7.5 / 月（Cruise $15 / 月）（本轮冻结） |
| 唯一来源 | 订阅后台 / 后端询价接口（`https://lightvela.com/subscribe/`） |
| 负责人 | ⬜ 待指定 |
| 镜像位置 | `frontend/next-site/subscribe-page.tsx:739-761`（静态价表 + 折扣常量）、`frontend/next-site/seo.tsx` `PLAN_OFFERS_BY_SEO_REGION`（JSON-LD）、`frontend/src/content/docs/plans.md:26-52`、`01-overview.md:95-102`、`announcements/public-beta.md:35-62` |
| 冲突 | ✅ **C2 判断已更正**（见 2.2）｜✅ **C3 已关闭**（见 2.3）｜✅ **4.1 JSON-LD 已修**（见 4.1） |

### 1.3 免费试用

| 项 | 内容 |
|---|---|
| 国内站 | 公测阶段**首次注册**用户，启航版免费体验 **14 天**；原内测用户现有套餐额外延长 **1 个月** ✅ 已确认 |
| 国际站 | 新用户 Launch 免费体验 **14 天**；原内测用户额外延长 **1 个月**（本轮不改动） |
| 唯一来源 | 运营规则（活动排期表） |
| 负责人 | ⬜ 待指定 |
| 镜像位置 | `frontend/src/content/docs/01-overview.md:9`、`announcements/public-beta.md:15,53`、`en|global/plans.md:39` |
| 冲突 | ✅ 国内站口径已统一为「公测阶段首次注册用户」 |

### 1.4 支持模型

| 项 | 内容 |
|---|---|
| 国内站 | Coding Plan：MiniMax、腾讯云 Token Plan、腾讯云、阿里云百炼、智谱、火山引擎方舟、Kimi、百度千帆（8）<br>API：DeepSeek、百炼（千问）、MiniMax、Kimi、智谱 GLM、火山引擎（豆包）、小米 MiMo、百度文心一言（8）<br>Claude / GPT / Gemini：仅「自定义模型」自备端点 |
| 国际站 | Coding Plan：智谱 GLM 国际、Kimi Coding Plan 等<br>API：Google Gemini、DeepSeek、Kimi 国际、智谱 GLM 国际、火山引擎（豆包）等<br>OpenAI GPT / Claude：「自定义模型」配置 |
| 唯一来源 | 产品配置（管理台模型下拉的线上配置） |
| 负责人 | ⬜ 待指定 |
| 镜像位置 | `frontend/src/content/docs/configuration/model.md:167-189`、`frontend/src/content/docs/global|en/configuration/model.md:97-144` |
| 冲突 | 🟡 **C6**（见 2.6） |

### 1.5 支持渠道

| 项 | 内容 |
|---|---|
| 国内站 | **5 个**：微信、QQ、企业微信、飞书、钉钉 ✅ 已确认（2026-08-20 更新，新增钉钉） |
| 国际站 | **8 个**：Telegram、WhatsApp、Discord、Slack、WeChat、QQ、WeCom、Lark ✅ 已确认（2026-08-20 更新，**Slack 已正式纳入**，C7 随之关闭） |
| 接入方式 | 国内站：微信 / 企业微信 / 飞书为扫码授权；QQ 可扫码或填 App ID / Secret；钉钉可扫码或填 Client ID / Secret |
| 唯一来源 | 产品配置：`src/pages/marketing/agent-channel-panel.tsx` 的 `HERMES_CHANNEL_LIST` 与管理台通道卡片可选项 |
| 负责人 | ⬜ 待指定 |
| 镜像位置 | `frontend/src/content/docs/configuration/channel-*.md`（现 3 个，**缺企业微信**）、`global|en/configuration/channel-*.md`（现 8 个，**多 Slack**）、`plans.md:47`、`announcements/public-beta.md:23`、`01-overview.md:29,53,68,81`、`04-core-concepts.md:30`、`create-first-hermes.md:59`、`credits.md:46`、`who-is-lightvela-for.md:3,17,35`、`frontend/src/app/llms.txt/route.next.ts:30,45`、`frontend/src/config/docs-sidebar.ts:77-80,162-170`、`frontend/src/lib/seo-data.ts` |
| 冲突 | ✅ **C4 已关闭**（渠道口径已统一为 5 个）｜✅ **C7 已关闭**（Slack 已确认支持，见 2.7）｜🟡 **C8 钉钉文档缺失**（见 2.8） |

### 1.6 是否实名

| 项 | 内容 |
|---|---|
| 国内站 | **是**。首次开通任意套餐前必须完成实名认证（真实姓名 + 身份证号，需中国大陆居民身份证），一次生效；续费前也需满足实名要求 |
| 国际站 | **否**。Google / GitHub 登录即可，不要求中国实名认证 |
| 唯一来源 | 账号规则（合规口径） |
| 负责人 | ⬜ 待指定 |
| 镜像位置 | `frontend/src/content/docs/03-account.md`、`02-quickstart.md:35-49`、`plans.md:109-115`、`07-faq.md:21-29`、`create-first-hermes.md:31-33`、`en|global/plans.md:89` |
| 冲突 | 无（两站口径一致且互斥，表述清晰） |

### 1.7 数据保留期

| 项 | 内容 |
|---|---|
| 国内站 | 套餐到期后数据自**到期日起保留 14 天**；保留期满数据释放且无法恢复 |
| 国际站 | ⬜ **待确认——对外文档完全缺失**（见 3.1） |
| 唯一来源 | 产品规则 |
| 负责人 | ⬜ 待指定 |
| 镜像位置 | `frontend/src/content/docs/plans.md:63`；国际站暂无落点，需新增 `global|en/plans.md` 段落 |
| 冲突 | 🔴 **C5** 缺口（见 3.1） |

### 1.8 套餐到期处理

| 项 | 内容 |
|---|---|
| 国内站 | 到期 → **1 天后权益暂停** → 保留期 14 天（可续费恢复，也可在账号页释放后重新购买）→ 保留期满**释放**，Agent 资源 / AI 积分 / 订单关联清除且不可恢复；已释放套餐不可续费。续费为手动，不自动扣费 |
| 国际站 | ⬜ **待确认——对外文档完全缺失**（是否同左？） |
| 唯一来源 | 产品规则 |
| 负责人 | ⬜ 待指定 |
| 镜像位置 | `frontend/src/content/docs/plans.md:57-91`；国际站暂无落点 |
| 冲突 | 🔴 **C5** 缺口（见 3.1） |

### 1.9 补充字段（GEO 高频被问，建议一并纳管）

| 字段 | 国内站 | 国际站 | 唯一来源 | 负责人 |
|---|---|---|---|---|
| 站点域名 | `lightvela.com` | `lightvela.ai` | 运维 / DNS | ⬜ |
| 登录方式 | QQ / 微信 | Google / GitHub | 账号规则 | ⬜ |
| 套餐档位数 | 4（启航 / 巡游 / 启航 AI / 巡游 AI） | 2（Launch / Cruise） | 订阅后台 | ⬜ |
| 月度积分 | 启航 100 / 巡游 200 / 启航 AI 4500 / 巡游 AI 10000 | Launch 100 / Cruise 200 | 产品配置 | ⬜ |
| 环境规格 | 启航 2C4G+50G；巡游 4C8G+80G | 同左 | 产品配置 | ⬜ |
| Agent 配额 | 每套餐 1 个 | 每套餐 1 个 | 产品配置 | ⬜ |
| 退款规则 | 每账号 1 次；月付 24h 内、季付 72h 内且未用 AI 积分 | ⬜ 待确认 | 产品规则 | ⬜ |
| 套餐升降级 | 暂不支持 | 暂不支持 | 产品规则 | ⬜ |
| 支付方式 | 微信扫码 | ⬜ 待确认 | 交易后台 | ⬜ |
| 出品团队 | 腾讯轻量云团队 | Tencent Lighthouse team | 品牌 | ⬜ |

---

## 2. 已发现的事实冲突（P0 优先修）

### 2.1 C1 ✅ 已关闭（国内站）：产品状态三种说法并存

**原问题**：国内站同时存在「现已进入公测」「计划将于 2026-08-18 转入公测」「内测期」三种说法，且「计划将于」在 2026-08-18 当天已过期。

**已修复（2026-08-18）**：以订阅后台计费开关为准，国内站统一为已发生时态。

| 位置 | 修改前 | 修改后 |
|---|---|---|
| `announcements/public-beta.md:3` | 计划将于…起转入公测并开启计费 | **已于 2026 年 8 月 18 日转入公测并开启计费** |
| `announcements/public-beta.md:13` | 预计公测及计费时间（新加坡时间） | **公测及计费时间 2026.08.18** |
| `announcements/public-beta.md:15` | 公测计费后的新用户权益 | **公测新用户权益｜首次注册用户可免费体验启航版 14 天** |
| `announcements/public-beta.md:33` | 计划自…起转入公测。正式开启计费后，我们将提供… | **已自…起转入公测并开启计费。开启计费后，我们提供…** |
| `announcements/public-beta.md:49-53` | 「内测伙伴的建议」「新用户」 | **「用户的建议」「公测阶段首次注册 LightVela 的用户」** |
| `announcements/public-beta.md:63,67` | 加入 LightVela **内测**交流群 | **用户交流群** |
| `plans.md:113-115` | **内测用户说明**／LightVela 内测期的用户 | **原内测用户说明**／在 LightVela 内测期注册的用户 |
| `contact-us.md:6,9` | LightVela **内测**交流群 | **用户交流群** |

`01-overview.md:5-11` 原本已是正确的「现已进入公测 + 14 天试用」，无需改动。

> 保留的「内测」表述均为**指代历史内测期用户权益**（如「原内测用户续费需更新实名」「内测用户套餐延长 1 个月」），语义正确，不属冲突。

**国际站**：按要求本轮冻结，`en|global/*` 仍为 `plans to enter public beta`。⚠️ 该表述自 2026-08-18 起已是过期未来时，建议尽快单独排期。

### 2.2 C2 🟡 判断修正：订阅页「限时免费」由运行时开关门控，非硬编码冲突

**我在上一轮的判断不准确，此处更正。**

`frontend/next-site/subscribe-page.tsx:2424`：

```
const freeGuideAllowed = !paidBillingEnabled && !realnamePhoneVerificationEnabled;
```

`:465`：`const paid = paidBillingEnabled && (!isGlobal || isLoggedIn);`

即「内测期间限时免费」（`:3247`）与 `¥49` 兜底锚点（`:591`）**只在计费开关关闭时才渲染**。
国内站计费开关已开启 → `paid=true`、`freeGuideAllowed=false` → 这两处对国内站用户**不可达**，展示的是后端真实价格。

**结论**：不是线上事实冲突，无需修改，也不应修改——它们是国际站（计费未开）和灰度回滚的兜底路径。

**遗留观察点**：`¥49` 作为国内站兜底锚点，在国内站已永久开启计费后属不可达分支。若确认不再回滚，可作为死代码清理（低优先级，需 Q2 确认）。

### 2.3 C3 ✅ 已关闭：AI 版价格

**已确认**：国内站 AI 版（启航 AI / 巡游 AI）**已正式可售**。

**已修复（2026-08-18）**：`announcements/public-beta.md` 删除「敬请期待」，补齐月付 / 季付原价 + 首购优惠表；并将「含 AI 积分的订阅版本敬请期待」改为「同时提供不含 AI 积分与含 AI 积分的订阅版本，均支持月付与季付」。
同步更新 `plans.md`（新增「优惠与首购价」表）与 `01-overview.md`（套餐表增加季付列）。

### 2.4 C4 🟡 文案已对齐，企业微信文档页已补齐

**已修复（第一轮）**：国内站渠道口径统一为 **微信、QQ、企业微信、飞书**，删除「逐步接入 …Telegram、WhatsApp、Discord」这类把路线图当已支持能力的表述。

涉及位置：`announcements/public-beta.md:23`、`01-overview.md:29,53,68,81`、`plans.md:47`、`04-core-concepts.md:30`、`create-first-hermes.md:59`、`credits.md:46`、`who-is-lightvela-for.md:3,17,35`、`llms.txt/route.next.ts:30`。

**已修复（第二轮，2026-08-18）**：补齐企业微信文档页缺口。

| 动作 | 位置 |
|---|---|
| 新建国内站企业微信文档 | `frontend/src/content/docs/configuration/channel-wecom.md`（复用 `global/configuration/channel-wecom.md` 并改为国内站上下文：启航套餐 100 体验积分、下一步链接指向国内站三个渠道页） |
| 侧边栏注册 + 顺序对齐 | `docs-sidebar.ts:77-81`，国内站通道顺序改为 **微信 / QQ / 企业微信 / 飞书**（原为 微信 / 飞书 / QQ），与确认清单及国际站 WeChat/QQ/WeCom/Lark 约定一致 |
| slug → 文件映射 | `docs-sidebar.ts:321-324` |
| 文件头注释同步 | `docs-sidebar.ts:10,29` |
| SEO title + description | `seo-data.ts` cn 表新增 `/docs/configuration/channel-wecom` |

图片资源 `images/wecom1~5.webp` 已存在，无需新增。

**副作用修复**：`llms.txt` 的「渠道配置」段由文档 slug 自动生成，补页后会自动输出 4 个渠道，与 intro 声称的 4 个一致。

**交叉印证**：官网落地页 `src/pages/marketing/landing/where-to-use-section.tsx:91-123` 国内站卡片已是 QQ、微信、飞书、企业微信 4 个，与确认清单一致 → 企业微信确实已上线，原属文档漏写。

### 2.5 C5 🔴 国际站数据保留期 / 到期处理：完全缺失

见 3.1。国际站本轮冻结，此项待国际站排期时一并处理。

### 2.6 C6 🟡 两站模型列表结构不对称

国内站分「Coding Plan / API」两张表共 16 项；国际站命名口径不同（如「智谱 AI（GLM 国际–Coding Plan）」）。
不算硬冲突，但 AI 引擎难以回答「LightVela 支持哪些模型」这类跨站问题。**修法**：统一列表结构与命名规则，增加「地区可用性」列。

### 2.7 C7 🔴 国际站 Slack：已确认「不支持」，但站内有 20+ 处仍在宣称支持

确认口径：国际站渠道为 **Telegram、Discord、WhatsApp、WeChat、QQ、WeCom、Lark（7 个）**，**不含 Slack**。

但 Slack 在站内是**完整存在**的，且分布在三个层次。以下为逐处清单（`grep -rn "Slack" src next-site`，已排除 i18n 生成物与 `/id/`）：

**A. 对外文档（AI 可抓取，优先级最高）**

| 位置 | 内容 |
|---|---|
| `src/content/docs/global/configuration/channel-slack.md` | 完整接入文档 |
| `src/content/docs/en/configuration/channel-slack.md` | 完整接入文档（英文） |
| `en/05-configuration.md:73,80,152` | 通道表含 Slack 行 + 两处链接 |
| `en/04-core-concepts.md:30,90,94` | 概念图、通道表、链接 |
| `en/02-quickstart.md:11` | 「Connecting Telegram / WhatsApp / Discord / **Slack** / WeChat channels」 |
| `en/configuration/model.md:209` | 下一步链接 |
| `en/configuration/channel-wechat.md:139` 等 | 各渠道页互链 |
| `en|global/plans.md:65` | 渠道列表写 8 个（含 Slack） |
| `hermes-agent/01-hermes-vs-openclaw.md:51` | 提及 Slack（**属技术对比叙述，非能力承诺，可保留**） |

**B. 站点配置 / SEO（机器可读层）**

| 位置 | 内容 |
|---|---|
| `src/config/docs-sidebar.ts:11,125,166` | 侧边栏 Slack 条目 + 两处注释 |
| `src/config/docs-sidebar.ts:361` | slug → 文件映射 |
| `src/lib/seo-data.ts:252-253,416` | 页面 title + description |
| `next-site/seo.tsx:84,107,119,132` | **4 处 keywords 含 `Slack bot`**（en/zh-sg/zh-hant/id 四语系） |
| `src/app/llms.txt/route.next.ts:45` | 国际站 intro：「connect channels like Telegram/WhatsApp/Discord/**Slack**」 |

**C. 产品代码（⚠️ 关键：不只是文案）**

| 位置 | 内容 |
|---|---|
| `src/pages/marketing/landing/where-to-use-section.tsx:125-138,172-179` | **落地页 Slack 卡片**（含手写 `SlackLogo` SVG + 描述「把 Hermes Agent 接入 Slack 工作区」）← **这就是你问的落地页** |
| `src/pages/marketing/agent-automations-panel.tsx:1738,2177` | 通道选项 `{ key: "slack", label: "Slack", comingSoon: false }` ← **标记为「非即将推出」，即产品内可选** |
| `src/pages/marketing/scenario-task-cron.ts:11` | 渠道标签映射 |
| `src/pages/marketing/changelog-page.tsx:254` | 更新日志：「支持快速接入 Telegram、WhatsApp、Discord、Slack 等通道」 |
| `__tests__/agent-settings-channel-slack.test.ts` | 「keeps Slack in LightVela-specific channel affordances」 |
| `__tests__/agent-tat-adapter.test.ts:110,148` | 「keeps Slack connected after…」「persists Slack connected status…」 |
| `__tests__/scenario-install-modal.test.tsx:76-87` | 断言 Slack 按钮存在 |
| `__tests__/global-changelog.test.tsx:188` | 断言 changelog 含 Slack |
| `scripts/slack-docs-publication.test.ts` | **专门的 Slack 文档发布契约测试**（4 项）：断言 en / global / zh-hant 三语系 Slack 文档存在、侧边栏中 Slack 排在 WeChat 之前、slug 已注册、图文接入指南完整 |
| `src/pages/marketing/__tests__/channel-copy.test.tsx` | 运行时 i18n 告警：`[i18n] 未在字典中找到："Slack"` |

> 📌 `scripts/slack-docs-publication.test.ts` 的存在说明 Slack 文档曾被作为**正式交付物**并写入契约测试保护。
> 若要下线，必须连同该测试文件一起处理，否则删文档会直接让 CI 红。
> 该测试当前已有 1 项失败（缺 `zh-hant` 生成物），属**既有问题**，与本轮改动无关。

**⚠️ 需要你再判断一次**：C 组显示 Slack 在**产品代码里是已实现且启用**的（`comingSoon: false`，且有测试断言「Slack 连接状态可持久化」）。
这与「目前还不支持 Slack」存在矛盾，可能是：
1. **能力已下线但代码未清理** → 需删除 A + B + C 全部（含测试），工作量较大且涉及产品代码；
2. **能力仍在但不对外主推** → 只需从对外文档与 SEO（A + B）移除，保留产品代码；
3. **仅国际站不支持、其他区域支持** → 需按 region 分别处理。

### ✅ C7 已关闭（2026-08-20）

产品侧最终确认：**国际站渠道为 8 个，Slack 在内**。即上面三种猜测都不成立 —— 实际情况是
「代码是对的，之前的口径判断有误」。站内 20+ 处 Slack 内容**全部保留、无需清理**，
测试断言（`agent-settings-channel-slack.test.ts` 等）也继续有效。

这条记录保留下来是有价值的：它说明当初「代码里有但口径说没有」时，
**先怀疑口径、不要急着删代码**是正确的处置 —— 若当时按猜测 1 清理，会误删仍在运行的能力。

另注：国际站落地页只展示 5 个渠道（WeChat、Telegram、WhatsApp、Discord、Slack），缺 QQ、WeCom、Lark；而文档写 8 个。若落地页是「营销精选」而非完整清单，建议补一句「以及 QQ、WeCom、Lark」，避免 AI 引擎按落地页低报能力。

---

### 2.8 C8 🟡 国内站钉钉已上线，但没有配置文档

master 提交 `35575bd19`（2026-08-19）在通道面板加入**钉钉**与 **Slack**，国内站通道数由 4 变 5。

本轮已把 5 个渠道的口径同步到全部文档、`llms.txt` 与本表，但**钉钉的配置文档尚不存在**：

| 缺口 | 影响 |
|---|---|
| `src/content/docs/configuration/channel-dingtalk.md` 不存在 | 用户在面板看到钉钉，却找不到接入教程 |
| `docs-sidebar.ts` 国内站通道组无钉钉条目 | 文档站侧边栏无入口 |
| `agent-channel-panel.tsx:41` 指向 `https://lightvela.ai/docs/configuration/channel-dingtalk` | **死链**（该文件在 en / global 也不存在）；仅国际站显示「配置教程」按钮，故当前只影响国际站 |
| `agent-channel-panel.tsx:37` feishu 指向 `.../channel-lark` | **死链**，实际文件名为 `channel-feishu.md`，同样只影响国际站 |

**本轮未创建钉钉文档**：从代码只能确定「扫码，或填写 Client ID / Secret」，
钉钉开放平台侧的具体创建步骤（应用类型、所需权限、回调配置）无法从代码推断，
硬写会造出与实际不符的操作步骤 —— 这正是本表要消灭的问题。

`04-core-concepts.md` 的通道表已列出钉钉，但**刻意不加文档链接**，改为注明「配置文档待补充」，
避免制造文档内死链。待产品侧提供步骤后补齐，并同步侧边栏、slug 映射与 `seo-data.ts`。

---

## 3. 事实缺口（对外文档没写，用户和 AI 都查不到）

### 3.1 国际站缺失「数据保留期」与「套餐到期处理」

国内站 `plans.md:57-91` 有完整的到期 → 暂停 → 保留 → 释放链路和 14 天保留期说明；
`en/plans.md` 与 `global/plans.md` **完全没有对应章节**。

**影响**：付费转化前的关键决策信息缺失；AI 引擎被问「What happens when my LightVela plan expires?」时无法从站点取到答案。

**修法**：产品负责人确认国际站规则（是否同国内站的 1 天暂停 + 14 天保留）后，在 `en|global/plans.md` 补齐。

### 3.2 国际站缺失退款规则与支付方式

国内站有完整退款规则（1 次机会 / 24h / 72h）和「微信扫码支付」；国际站两项均无。

---

## 4. 机器可读层错误（GEO 直接受影响，优先级同 P0）

### 4.1 ✅ 已修复：JSON-LD 报「免费」，与实际价格矛盾

**原问题**：`frontend/next-site/seo.tsx` 的 `SoftwareApplicationJsonLd` 输出

```
offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD'|'CNY', availability: 'InStock' }
```

结构化数据是 AI 引擎与 Google 富摘要**最高置信度**的输入，却明确声明产品价格为 0，而文档写 ¥45 / $7.5。这是全站最严重的单点事实冲突。

**已修复（2026-08-18）**：改用 `AggregateOffer` 表达价格区间，并抽出 `PLAN_OFFERS_BY_SEO_REGION` 常量集中维护：

| region | 输出 |
|---|---|
| cn | `AggregateOffer`｜CNY｜lowPrice `0`｜highPrice `158`｜offerCount 4 |
| global | `AggregateOffer`｜USD｜lowPrice `7.5`｜highPrice `15`｜offerCount 2 |

设计说明：
- 国内站 4 档套餐 × 月付/季付，单一 `price` 无法表达，故用 `AggregateOffer`。
- `lowPrice: 0` 在此语义是「存在免费试用入口」（启航首单免费 14 天），与文档一致；
  与改造前把**整个产品**标成 `price: '0'` 的错误声明性质不同。
- `highPrice: 158` 取最高月付原价（巡游 AI）。
- 常量块内注明价格真源为本表 1.2，并要求与 `subscribe-page.tsx` 静态价表同步。

**遗留**：国际站 `$7.5 / $15` 沿用原值，待国际站计费状态确认后复核。

### 4.2 🔴 未修复且已实测确认：权威价格页 `/subscribe` 对爬虫完全不可见

`frontend/src/lib/seo-data.ts:67-80` 将 `/subscribe` 列入 `NON_INDEXABLE_PREFIXES`。

**本轮实测**（2026-08-18 抓取 `https://lightvela.com/subscribe/`）证实问题比预估更严重，存在**双重不可见**：

1. `robots: noindex, nofollow` —— 搜索引擎与 AI 爬虫被明确拒绝收录；
2. **纯客户端渲染** —— 返回的 HTML 只有 `animate-pulse` 骨架屏，且含两处
   `<template data-dgst="BAILOUT_TO_CLIENT_SIDE_RENDERING">`，`<main aria-hidden="true">`。
   即便允许抓取，不执行 JS 也拿不到任何价格文字。

**后果**：唯一实时准确的价格页对 AI 引擎零可见。引擎只能读到文档里的镜像价格，文档一旦滞后，站外就只剩错误价格。

**当前缓解**：本轮已把完整价格（月付 / 季付 / 首购价 / 折扣）写入 `/docs/plans` 与公告页，这两页可索引，等效于把 `/docs/plans` 确立为对外权威价格页。

**已加自动化防护**：新增 `frontend/next-site/__tests__/plan-pricing-consistency.test.ts`（25 项断言），见 4.3。

### 4.3 ✅ 已加防护：价格一致性契约测试

价格散落 5 处、历史已两次漂移，故加自动化校验。

**设计**：以 `subscribe-page.tsx` 的静态价表为**唯一解析基准**（它与后端询价口径对齐，最接近真源「订阅后台」），反向校验其余位置。不在测试里另写一份期望价格——否则只是新增第 6 处镜像。

**覆盖范围**：

| 校验项 | 说明 |
|---|---|
| 季付原价 = 月付 × 3 | 四档套餐 |
| `docs/plans.md` 定价表 | 月付 / 季付原价 × 4 档 |
| `docs/plans.md` 优惠表 | 首购价 = 月付 × 折扣；季付折后价 = 季付 × 折扣 |
| `docs/01-overview.md` 套餐表 | 月付 / 季付原价 × 4 档 |
| `announcements/public-beta.md` | 月付 / 季付原价 × 4 档 |
| 「敬请期待」回归防护 | AI 版价格单元格不得再出现占位文案（C3 回归） |
| JSON-LD | `AggregateOffer`；`highPrice` = 最高月付原价；`offerCount` = 档位数；`lowPrice` = 0；币种 CNY |
| `price: '0'` 回归防护 | 剥离注释后断言源码不含该写法（4.1 回归） |

**实现要点**：
- 表格按 **小节标题定位**（`sectionOf`），而非全文找首列。`plans.md` 有三张表都含「启航 Launch」行，只按标签匹配会命中「套餐权益」表 → 首次运行即暴露此问题并已修正。
- 首列用**全等**匹配，避免「启航 Launch」误命中「启航 Launch AI」。
- 源码断言前**剥离注释**（`stripComments`），否则注释里记录的历史错误写法 `price:'0'` 会误判违规 → 首次运行即暴露并已修正。

**变异测试验证**（确认能真正拦住漂移，非空跑）：

| 注入的漂移 | 结果 |
|---|---|
| `plans.md` 启航月付改 ¥45 → ¥49 | ✅ 捕获：`启航 Launch 月付原价: expected 49 to be 45` |
| 基准价改 45/135 → 50/150（模拟后端调价未同步文档） | ✅ 捕获 **4 处**未同步位置（三份文档 + 派生季付折后价） |
| JSON-LD 回退为 `Offer` + `price:'0'` | ✅ 捕获 4 项断言失败 |

**未覆盖**：国际站价格（$7.5 / $15）暂未纳入，待国际站计费状态确认后补。

### 4.4 `llms.txt` 只有导航、没有事实

`frontend/src/app/llms.txt/route.next.ts` 目前只输出 tagline + 链接列表。
`llms.txt` 是面向 AI 的首要入口，最该放的恰恰是本表这类**结构化事实摘要**（当前状态、价格、试用、渠道、实名要求、保留期）。

**修法**：事实表确认后，从同一份数据源生成 `llms.txt` 的「Key Facts」段落，实现事实表 → 对外机器可读层的单向同步。

### 4.5 ✅ 已修复：`region.ts` 注释域名写错

`frontend/src/lib/region.ts:15-16` 原注释写「`cn`：国内站（lightvela.cn）/ `global`：国际站（lightvela.com）」，
实际值是 `cn` → `lightvela.com`、`global` → `lightvela.ai`（`seo.tsx`、`seo-data.ts:51-64`）。
不影响线上行为，但会持续误导后续维护者和 AI 编码助手。已改正并补充指向域名真源与本表的说明。

---

## 5. 待产品负责人确认清单

修文案前必须先拿到这些答案，否则改完还是猜的：

| # | 待确认 | 影响范围 | 状态 |
|---|---|---|---|
| Q1 | 国内站 / 国际站截至今天的**实际计费状态** | C1、C2、4.1 全部文案 | ✅ **已确认**：国内站已公测并计费，首次注册用户启航版免费 14 天；国际站本轮冻结 |
| Q4 | 国内站**当前真实可用**的渠道清单 | C4、渠道文档、llms.txt、SEO keywords | ✅ **已确认（2026-08-20 更新）**：国内站微信、QQ、企业微信、飞书、钉钉（5 个）；国际站 Telegram、WhatsApp、Discord、Slack、WeChat、QQ、WeCom、Lark（8 个） |
| Q2 | `¥49` 兜底锚点是否还需保留？（国内站已开启计费，该分支已不可达） | `subscribe-page.tsx:591` 死代码清理 | ⬜ 待确认（低优先级） |
| Q3 | AI 版（启航 AI / 巡游 AI）是否已正式上线可售？ | C3、公告页 | ✅ **已确认**：国内站 AI 版已可售，公告页已补全价格 |
| Q5 | 国际站数据保留期与到期处理规则（是否同国内站的 1 天暂停 + 14 天保留） | 3.1 | ⬜ 待确认（随国际站排期） |
| Q6 | 国际站退款规则与支付方式 | 3.2 | ⬜ 待确认（随国际站排期） |
| Q7 | 「14 天免费试用」是长期政策还是公测期限时活动？有无结束日期？ | 1.3 全部文案 | ⬜ 待确认 |
| Q8 | 结构化数据对外披露的价格口径 | 4.1 JSON-LD | ✅ **已确认**：月付 + 季付 + 原价 + 首购价，已改为 AggregateOffer 价格区间 |
| Q9 | 国内站企业微信接入步骤 | 2.4 缺口 | ✅ **已确认**：复用国际站 WeCom 文档改为国内站版本，已完成 |
| Q10 | 国际站 **Slack** 处理方式 | C7，涉及 A/B/C 三层共 20+ 处 | ✅ **已确认（2026-08-20）**：Slack **正式支持**，国际站 8 渠道之一。站内 20+ 处全部保留，无需清理 —— 当初「代码里有但口径说没有」时选择先怀疑口径而非删代码，是正确处置 |
| Q11 | 国内站**钉钉**接入步骤（钉钉开放平台侧：应用类型、所需权限、回调配置） | C8，阻塞 `channel-dingtalk.md` 创建 | 🔴 **待确认**：代码只能确定「扫码或填 Client ID / Secret」，其余无法从代码推断，硬写会造出与实际不符的步骤 |

---

## 6. 验收标准

对齐图中口径，并补充可执行判据：

1. **每个事实只有一个负责人和一个最终来源** —— 本表第 1 节所有 ⬜ 负责人填满，无空缺。
2. 第 2 节全部 🔴 冲突关闭，站内检索同一事实只得到一种说法。
3. 第 3 节缺口补齐，国际站与国内站在这 8 个字段上都能被回答。
4. 第 4 节机器可读层与本表一致，JSON-LD 不再出现 `price: '0'`。
5. 后续任何对外文案改动，可追溯到本表某一行的「唯一来源」。
6. **价格类事实有自动化防护**：`pnpm test` 中 `plan-pricing-consistency.test.ts` 全绿；改价格时若漏改任一镜像位置，CI 必须失败。

### 当前进度

| 项 | 状态 |
|---|---|
| 1 负责人填满 | ⬜ 全部待指定 |
| 2 冲突关闭 | C1 ✅／C2 ✅（判断更正）／C3 ✅／C4 ✅（渠道口径已统一为 5 个）／C5 ⏸️（国际站冻结）／C6 🟡／C7 ✅（Slack 确认支持）／C8 🟡（钉钉文档缺失，待 Q11） |
| 3 缺口补齐 | ⏸️ 国际站冻结，待排期 |
| 4 机器可读层 | 4.1 ✅／4.2 🟡（已缓解，`/subscribe` 仍不可见）／4.3 ✅／4.4 ⬜／4.5 ✅ |
| 5 可追溯 | ✅ 本表已建立镜像位置索引 |
| 6 价格防护 | ✅ 25 项断言 + 3 组变异测试验证 |

---

## 7. 维护规则

- 本表是**事实的索引**，不是事实本身。真值永远在「唯一来源」（订阅后台 / 产品配置 / 运营规则 / 账号规则 / 产品规则）。
- 来源变更 → 先更新本表 → 再按「镜像位置」逐一同步 → 最后同步机器可读层（JSON-LD / llms.txt / SEO metadata）。
- **改价格的正确顺序**：先改 `next-site/subscribe-page.tsx` 静态价表 → 跑 `pnpm test`，测试会逐一列出还没同步的位置 → 按提示改文档与 JSON-LD → 全绿即同步完成。
- 镜像位置的行号会随代码漂移，以文件路径 + 上下文为准；新增镜像点必须回填本表，并考虑是否需要纳入契约测试。
- 相关规范参见 `.agents/skills/product-skills/lv-docs/references/docs-rules.md`。
