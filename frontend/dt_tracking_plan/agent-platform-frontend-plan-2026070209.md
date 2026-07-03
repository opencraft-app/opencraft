# agent-platform-frontend 埋点方案（大同）

> 生成时间：2026-07-02  
> 项目：`agent-platform-frontend`（Next.js 16 + React 19 + TypeScript）  
> AppKey：`0WEB071LS3218EU7`　·　AppId：`pwnlm6jlch`  
> SDK 选型：`sdk/h5/universal-report`（H5 通用上报，适配 Next.js App Router SPA/SSR 混合）  
> 规范来源：**大同默认规范**（`custom-specs/` 无业务自定义规范）  
> 场景：SaaS 与订阅 / B2B（`scenario-library/05`）+ AI Agent 平台自定义业务  

---

## 一、覆盖模块与主键规模

| 模块 | 页面数 | 手动事件数 | 说明 |
|------|:----:|:----:|------|
| 公开站（首页 / About / Changelog / Docs / OSL / Cookie / Privacy） | 8 | 0 | 仅 `dt_pgin`/`dt_pgout` |
| 订阅漏斗（Plans / PlanSelect / Subscribe） | 3 | 3 | 选择套餐、发起支付、支付成功/失败 |
| Account（个人中心 / 订单） | 2 | 0 | — |
| Agent 首页 & 创建 | 1 | 4 | 开始创建、创建成功/失败、进入控制台 |
| Agent Channels（IM 连接） | 1 | 3 | 点击 Guide、点击 Connect、连接成功 |
| Agent Models | 1 | 5 | 切换模型、选择供应商、添加 API Key、添加自定义模型 |
| Agent Skills（技能 / 技能包） | 1 | 5 | 搜索、点击/安装技能、点击/安装技能包 |
| Agent Persona（Soul） | 1 | 4 | 抽取、选择、注入成功、注入失败 |
| Agent Automations | 1 | 4 | 打开模板、创建任务、创建成功、删除任务 |
| Agent Memory | 1 | 1 | 更新限额 |
| Agent Files（Storage） | 1 | 0 | 仅 `dt_pgin`/`dt_pgout` |
| Agent Diagnostics | 1 | 1 | 执行操作 |
| Agent 会话 & 对话 | 1 | 3 | 会话曝光、消息发送/失败（AI 核心事件） |

- **页面（`dt_pgid`）总计**：24 个  
- **自定义事件（`event_code`）总计**：15 个  
- **表格行数（三字段主键）**：约 100 行  

---

## 二、公共参数（每个事件自动携带）

| 参数 key | 说明 | 采集时机 |
|--------|------|--------|
| `user_id` | 登录后的用户 UID；未登录留空 | SDK 全局 setUserId |
| `locale` | 语言（`zh-CN` / `en-US`） | 由 `i18n/index.ts` 注入 |
| `region` | 部署区域（`cn` / `global`） | 由 `NEXT_PUBLIC_REGION` 注入 |
| `plan_tier` | 用户订阅等级（`free` / `basic` / `pro` / `enterprise`） | 由 `session-context` 注入 |
| `is_login` | 是否已登录（`0` / `1`） | 由 `session-context` 注入 |
| `page_name` | 页面英文标识（等同 `dt_pgid`，冗余便于分析） | SDK 页面事件自动填充 |

> ⚠️ 公参统一在 SDK 初始化的 `commonProps()` 回调里读取，业务代码调用埋点 API 时**不需要**手动传入。

---

## 三、页面 `dt_pgid` 命名映射

| 路由 | `dt_pgid` | 页面中文名 | 关键组件 |
|------|-----------|----------|--------|
| `/`、`/[lang]` | `home` | 首页（Landing） | `pages/marketing/landing-page.tsx` |
| `/about` | `about` | 关于我们 | `app/(site)/about/page.next.tsx` |
| `/changelog` | `changelog` | 更新日志 | `changelog/page.next.tsx` |
| `/docs/**` | `docs` | 文档中心 | `docs/[[...slug]]/page.next.tsx` |
| `/cookie-policy` | `cookie_policy` | Cookie 政策 | — |
| `/privacy-policy` | `privacy_policy` | 隐私政策 | — |
| `/open-source-licenses` | `open_source_licenses` | 开源许可 | — |
| `/plans` | `plans` | 套餐选择页 | `app/(site)/plans/page.next.tsx` |
| `/plans/select` | `plan_select` | 套餐比对/选择页 | `plans/select/page.next.tsx` |
| `/subscribe` | `subscribe` | 支付/订阅页 | `next-site/subscribe-page.tsx` |
| `/account` | `account` | 账户中心 | `account/page.next.tsx` |
| `/account/orders` | `account_orders` | 我的订单 | `account/orders/page.next.tsx` |
| `/agents` | `agents_home` | Agent 列表/首页 | `agents/page.next.tsx` |
| `/agents?creating=true` | `agent_creating` | Agent 创建向导 | 由 `getAgentCreatingPath(true)` 触发 |
| `/agents/workbench`、`/agents/session` | `agent_workbench` | 控制台工作台 | sectionId = `workbench` |
| `/agents/chat` | `agent_chat` | 会话页 | sectionId = `chat` |
| `/agents/channels` | `agent_channels` | IM 通道页 | sectionId = `channel` |
| `/agents/models` | `agent_models` | 模型配置页 | sectionId = `model` |
| `/agents/skills`、`/agents/experts`、`/agents/packages` | `agent_skills` | 技能与技能包页 | sectionId = `skill` |
| `/agents/persona` | `agent_persona` | 人设 / Soul 页 | sectionId = `buddy` |
| `/agents/automations` | `agent_automations` | 自动任务页 | sectionId = `automations` |
| `/agents/memory` | `agent_memory` | 记忆页 | sectionId = `memory` |
| `/agents/files` | `agent_files` | 云存储页 | sectionId = `files` |
| `/agents/diagnostics` | `agent_diagnostics` | 诊断页 | sectionId = `diagnostics` |
| `/agents/browser`、`/agents/terminal`、`/agents/achievements` | `agent_browser` / `agent_terminal` / `agent_achievement` | 其他 section | 兜底页面曝光 |

> `dt_pgid` 与 `AGENT_SECTION_ID_BY_SLUG` 保持语义对齐，便于后续按 sectionId 做维度切片。

---

## 四、埋点事件表（固定 7 列，每行一主键）

### 4.1 全站页面曝光（声明式，SDK 自动采集）

| 触发时机 trigger | 示意图 ui | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|-----------|:----:|-------|-------|:----:|-------|-------|
| 路由进入首页时 | — | `dt_pgin` 页面曝光 | `home` 首页 | — | — | 覆盖 `/` 与 `/[lang]` |
| 路由离开首页时 | — | `dt_pgout` 页面结束曝光 | `home` 首页 | — | `dt_lvtm` 停留时长 | — |
| 路由进入 About 页 | — | `dt_pgin` 页面曝光 | `about` 关于我们 | — | — | — |
| 路由离开 About 页 | — | `dt_pgout` 页面结束曝光 | `about` 关于我们 | — | `dt_lvtm` 停留时长 | — |
| 路由进入 Changelog | — | `dt_pgin` 页面曝光 | `changelog` 更新日志 | — | — | — |
| 路由离开 Changelog | — | `dt_pgout` 页面结束曝光 | `changelog` 更新日志 | — | `dt_lvtm` 停留时长 | — |
| 路由进入文档页 | — | `dt_pgin` 页面曝光 | `docs` 文档中心 | — | `doc_slug` 文档路径 | 由 `[[...slug]]` 提供 |
| 路由离开文档页 | — | `dt_pgout` 页面结束曝光 | `docs` 文档中心 | — | `dt_lvtm` 停留时长；`doc_slug` 文档路径 | — |
| 路由进入 Cookie 政策 | — | `dt_pgin` 页面曝光 | `cookie_policy` Cookie 政策 | — | — | — |
| 路由进入隐私政策 | — | `dt_pgin` 页面曝光 | `privacy_policy` 隐私政策 | — | — | — |
| 路由进入开源许可 | — | `dt_pgin` 页面曝光 | `open_source_licenses` 开源许可 | — | — | — |
| 路由进入套餐页 | — | `dt_pgin` 页面曝光 | `plans` 套餐选择页 | — | — | 用户核心指标"进入套餐页" |
| 路由离开套餐页 | — | `dt_pgout` 页面结束曝光 | `plans` 套餐选择页 | — | `dt_lvtm` 停留时长 | — |
| 路由进入套餐比对页 | — | `dt_pgin` 页面曝光 | `plan_select` 套餐比对页 | — | — | — |
| 路由进入支付页 | — | `dt_pgin` 页面曝光 | `subscribe` 支付页 | — | `plan` 套餐编码；`billing_period` 计费周期 | — |
| 路由离开支付页 | — | `dt_pgout` 页面结束曝光 | `subscribe` 支付页 | — | `dt_lvtm` 停留时长 | — |
| 路由进入账户中心 | — | `dt_pgin` 页面曝光 | `account` 账户中心 | — | — | 用户核心指标"进入 Account 页" |
| 路由离开账户中心 | — | `dt_pgout` 页面结束曝光 | `account` 账户中心 | — | `dt_lvtm` 停留时长 | — |
| 路由进入我的订单 | — | `dt_pgin` 页面曝光 | `account_orders` 我的订单 | — | — | — |
| 路由进入 Agent 首页 | — | `dt_pgin` 页面曝光 | `agents_home` Agent 首页 | — | `bots_count` 已有 Bot 数量 | — |
| 路由进入 Agent 创建向导 | — | `dt_pgin` 页面曝光 | `agent_creating` Agent 创建向导 | — | `entry` 入口来源 | 由 `?creating=true` 触发 |
| 路由进入 Agent 工作台 | — | `dt_pgin` 页面曝光 | `agent_workbench` Agent 工作台 | — | `bot_id` Agent ID | 用户核心指标"进入控制台" |
| 路由离开 Agent 工作台 | — | `dt_pgout` 页面结束曝光 | `agent_workbench` Agent 工作台 | — | `dt_lvtm` 停留时长；`bot_id` Agent ID | — |
| 路由进入会话页 | — | `dt_pgin` 页面曝光 | `agent_chat` Agent 会话页 | — | `bot_id` Agent ID | — |
| 路由进入 Channels 页 | — | `dt_pgin` 页面曝光 | `agent_channels` IM 通道页 | — | `bot_id` Agent ID | 用户核心指标"进入 Channel 页" |
| 路由进入 Models 页 | — | `dt_pgin` 页面曝光 | `agent_models` 模型配置页 | — | `bot_id` Agent ID | 用户核心指标"进入 Model 页" |
| 路由进入 Skills 页 | — | `dt_pgin` 页面曝光 | `agent_skills` 技能页 | — | `bot_id` Agent ID；`sub_tab` 子 Tab | 覆盖 skills/experts/packages |
| 路由进入 Persona 页 | — | `dt_pgin` 页面曝光 | `agent_persona` 人设页 | — | `bot_id` Agent ID | 用户核心指标"进入 Soul 页" |
| 路由进入 Automations 页 | — | `dt_pgin` 页面曝光 | `agent_automations` 自动任务页 | — | `bot_id` Agent ID | — |
| 路由进入 Memory 页 | — | `dt_pgin` 页面曝光 | `agent_memory` 记忆页 | — | `bot_id` Agent ID | — |
| 路由进入 Files 页 | — | `dt_pgin` 页面曝光 | `agent_files` 云存储页 | — | `bot_id` Agent ID | 用户核心指标"进入 Storage 页" |
| 路由进入 Diagnostics 页 | — | `dt_pgin` 页面曝光 | `agent_diagnostics` 诊断页 | — | `bot_id` Agent ID | — |

### 4.2 关键 CTA 与元素点击（声明式 `dt_clck` / `dt_imp`）

| 触发时机 trigger | 示意图 ui | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|-----------|:----:|-------|-------|:----:|-------|-------|
| 首页顶栏"Create Now"按钮点击 | — | `dt_clck` 元素点击 | `home` 首页 | `header_create_now_btn` | `has_bots` 已有 Bot；`target` 跳转目标 | 位于 `public-header-auth-island.tsx` |
| 首页 Hero 区"Create Now"点击 | — | `dt_clck` 元素点击 | `home` 首页 | `hero_create_now_btn` | `has_bots` 已有 Bot；`target` 跳转目标 | 位于 `hero-section.tsx` |
| 首页底部 CTA"Create Now"点击 | — | `dt_clck` 元素点击 | `home` 首页 | `footer_create_now_btn` | `has_bots` 已有 Bot；`target` 跳转目标 | 位于 `cta-footer-section.tsx` |
| 顶栏 Login 按钮点击 | — | `dt_clck` 元素点击 | `home` 首页 | `header_login_btn` | — | — |
| 顶栏 Docs 入口点击 | — | `dt_clck` 元素点击 | `home` 首页 | `header_docs_link` | — | — |
| 顶栏 Pricing 入口点击 | — | `dt_clck` 元素点击 | `home` 首页 | `header_pricing_link` | — | — |
| 语言切换器点击 | — | `dt_clck` 元素点击 | `home` 首页 | `language_switcher_btn` | `from_locale` 原语言；`to_locale` 目标语言 | 用户切换语言时 |
| Plan 卡片曝光（用于 CTR 分析） | — | `dt_imp` 元素曝光 | `plans` 套餐选择页 | `plan_card` | `plan` 套餐编码；`billing_period` 计费周期 | 每张卡首次进入视口时触发 |
| Plan 卡片曝光结束 | — | `dt_imp_end` 元素结束曝光 | `plans` 套餐选择页 | `plan_card` | `plan` 套餐编码；`view_duration` 曝光时长 | — |
| Plan 卡片"选择"按钮点击 | — | `dt_clck` 元素点击 | `plans` 套餐选择页 | `plan_select_btn` | `plan` 套餐编码；`billing_period` 计费周期 | 用户核心指标"选择套餐" |
| 套餐周期切换（月/年） | — | `dt_clck` 元素点击 | `plans` 套餐选择页 | `billing_period_toggle` | `to_period` 目标周期 | — |
| 支付页"立即支付"按钮点击 | — | `dt_clck` 元素点击 | `subscribe` 支付页 | `pay_now_btn` | `plan` 套餐编码；`billing_period` 计费周期；`pay_channel` 支付渠道 | 用户核心指标"发起支付"配套点击 |
| 账户中心侧栏"订单"入口点击 | — | `dt_clck` 元素点击 | `account` 账户中心 | `orders_entry_link` | — | — |
| Agent 首页"开始创建"点击 | — | `dt_clck` 元素点击 | `agents_home` Agent 首页 | `agent_create_start_btn` | `bots_count` 现有 Bot 数量 | 用户核心指标"点击开始创建" |
| Agent 卡片"进入控制台"点击 | — | `dt_clck` 元素点击 | `agents_home` Agent 首页 | `agent_enter_console_btn` | `bot_id` Agent ID；`bot_status` Bot 状态 | — |
| Agent 卡片"Restart"点击 | — | `dt_clck` 元素点击 | `agents_home` Agent 首页 | `agent_restart_btn` | `bot_id` Agent ID | 用户 P2 指标"点击 Restart" |
| Agent 卡片"Delete"点击 | — | `dt_clck` 元素点击 | `agents_home` Agent 首页 | `agent_delete_btn` | `bot_id` Agent ID | 用户 P1 指标"点击 Delete" |
| Channels 页 Guide 按钮点击 | — | `dt_clck` 元素点击 | `agent_channels` IM 通道页 | `channel_guide_btn` | `bot_id` Agent ID；`channel_type` 通道类型 | 用户 P1 指标"点击 Guide" |
| Channels 页 Connect 按钮点击 | — | `dt_clck` 元素点击 | `agent_channels` IM 通道页 | `channel_connect_btn` | `bot_id` Agent ID；`channel_type` 通道类型（telegram/discord/wechat/whatsapp） | 用户 P0 指标"点击 Connect" |
| Skills 页搜索框聚焦 | — | `dt_clck` 元素点击 | `agent_skills` 技能页 | `skills_search_input` | `bot_id` Agent ID | — |
| 技能卡片点击 | — | `dt_clck` 元素点击 | `agent_skills` 技能页 | `skill_item_card` | `bot_id` Agent ID；`skill_id` 技能 ID；`skill_name` 技能名 | — |
| 技能包卡片点击 | — | `dt_clck` 元素点击 | `agent_skills` 技能页 | `skill_pack_card` | `bot_id` Agent ID；`pack_id` 技能包 ID | 用户 P2 指标"点击技能包" |
| Persona 抽取按钮点击 | — | `dt_clck` 元素点击 | `agent_persona` 人设页 | `persona_draw_btn` | `bot_id` Agent ID | 用户 P2 指标"点击抽取" |
| Persona 卡片选择点击 | — | `dt_clck` 元素点击 | `agent_persona` 人设页 | `persona_select_card` | `bot_id` Agent ID；`persona_id` 人设 ID | 用户 P2 指标"选择 Soul" |
| Automations 模板打开点击 | — | `dt_clck` 元素点击 | `agent_automations` 自动任务页 | `automation_template_card` | `bot_id` Agent ID；`template_id` 模板 ID | 用户 P2 指标"打开模板" |

### 4.3 自定义业务事件（代码打点）

| 触发时机 trigger | 示意图 ui | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|-----------|:----:|-------|-------|:----:|-------|-------|
| 用户点击登录按钮开始登录流程时 | — | `login_attempt` 登录发起 | `home` 首页 | — | `method` 登录方式（wechat/github/email） | 位于 `login-modal.tsx` |
| 登录成功回调时 | — | `login_success` 登录成功 | — | — | `method` 登录方式；`is_new_user` 是否新用户 | 与页面无关 |
| 登录失败时 | — | `login_fail` 登录失败 | — | — | `method` 登录方式；`error_code` 错误码；`error_msg` 错误消息 | — |
| 支付页发起支付调用时 | — | `subscribe_checkout_start` 发起支付 | `subscribe` 支付页 | — | `plan` 套餐编码；`billing_period` 计费周期；`pay_channel` 支付渠道；`amount` 金额；`currency` 币种 | 用户核心指标"发起支付" |
| 支付回调成功时 | — | `subscribe_pay_success` 支付成功 | `subscribe` 支付页 | — | `plan` 套餐编码；`billing_period` 计费周期；`pay_channel` 支付渠道；`amount` 金额；`order_id` 订单号 | — |
| 支付失败或取消时 | — | `subscribe_pay_fail` 支付失败 | `subscribe` 支付页 | — | `plan` 套餐编码；`pay_channel` 支付渠道；`fail_reason` 失败原因；`error_code` 错误码 | — |
| Agent 创建接口成功返回时 | — | `agent_create_success` Agent 创建成功 | `agent_creating` Agent 创建向导 | — | `bot_id` 新 Agent ID；`create_duration_ms` 创建耗时 | 判断激活漏斗 |
| Agent 创建失败时 | — | `agent_create_fail` Agent 创建失败 | `agent_creating` Agent 创建向导 | — | `error_code` 错误码；`error_msg` 错误消息 | — |
| IM 通道连接接口返回成功时 | — | `channel_connect_success` 通道连接成功 | `agent_channels` IM 通道页 | — | `bot_id` Agent ID；`channel_type` 通道类型 | 用户 P0 指标"通道连接数" |
| Model 切换成功时 | — | `model_switch` 模型切换 | `agent_models` 模型配置页 | — | `bot_id` Agent ID；`from_model` 原模型；`to_model` 目标模型；`provider` 供应商 | 用户 P1 指标"切换模型" |
| 供应商选择完成时 | — | `model_provider_select` 选择供应商 | `agent_models` 模型配置页 | — | `bot_id` Agent ID；`provider` 供应商 | 用户 P1 指标"选择供应商" |
| API Key 保存成功时 | — | `model_api_key_add` 添加 API Key | `agent_models` 模型配置页 | — | `bot_id` Agent ID；`provider` 供应商 | 用户 P2 指标"添加 API Key"，参数不包含 key 明文 |
| 自定义模型保存成功时 | — | `model_custom_add` 添加自定义模型 | `agent_models` 模型配置页 | — | `bot_id` Agent ID；`model_name` 自定义模型名；`endpoint_type` 接口类型 | 用户 P1 指标"添加自定义模型" |
| Skills 页搜索接口调用时 | — | `skill_search` 技能搜索 | `agent_skills` 技能页 | — | `bot_id` Agent ID；`keyword` 搜索词；`result_count` 结果数 | 用户 P2 指标"搜索技能" |
| 技能安装成功时 | — | `skill_install_success` 技能安装成功 | `agent_skills` 技能页 | — | `bot_id` Agent ID；`skill_id` 技能 ID；`skill_name` 技能名 | 用户 P1 指标"安装技能" |
| 技能包安装成功时 | — | `skill_pack_install_success` 技能包安装成功 | `agent_skills` 技能页 | — | `bot_id` Agent ID；`pack_id` 技能包 ID；`skill_count` 包内技能数 | 用户 P1 指标"安装技能包" |
| Persona 注入接口成功时 | — | `persona_inject_success` 人设注入成功 | `agent_persona` 人设页 | — | `bot_id` Agent ID；`persona_id` 人设 ID；`persona_source` 来源（draw/manual） | 用户 P1 指标"注入成功" |
| Persona 注入失败时 | — | `persona_inject_fail` 人设注入失败 | `agent_persona` 人设页 | — | `bot_id` Agent ID；`error_code` 错误码 | — |
| 自动任务创建接口成功时 | — | `automation_create_success` 自动任务创建 | `agent_automations` 自动任务页 | — | `bot_id` Agent ID；`task_id` 任务 ID；`schedule_type` 调度类型（cron/interval/once） | 用户 P1 指标"创建任务" |
| 自动任务删除成功时 | — | `automation_delete` 自动任务删除 | `agent_automations` 自动任务页 | — | `bot_id` Agent ID；`task_id` 任务 ID | 用户 P2 指标"删除任务" |
| Memory 限额更新接口成功时 | — | `memory_quota_update` 记忆限额更新 | `agent_memory` 记忆页 | — | `bot_id` Agent ID；`old_quota` 原限额；`new_quota` 新限额 | 用户 P2 指标"更新限额" |
| Diagnostics 执行操作触发时 | — | `diagnostics_action` 诊断操作 | `agent_diagnostics` 诊断页 | — | `bot_id` Agent ID；`action` 操作类型（restart/log_pull/env_reset 等） | 用户 P1 指标"执行操作" |
| AI 会话消息发送成功时 | — | `agent_message_send` Agent 消息发送 | `agent_chat` 会话页 | — | `bot_id` Agent ID；`msg_len` 消息长度；`session_id` 会话 ID；`model` 使用模型 | **North Star 指标依赖** |
| AI 会话消息失败时 | — | `agent_message_fail` Agent 消息失败 | `agent_chat` 会话页 | — | `bot_id` Agent ID；`session_id` 会话 ID；`error_code` 错误码；`error_msg` 错误消息 | 护栏指标 |
| 文档搜索接口触发时 | — | `doc_search` 文档搜索 | `docs` 文档中心 | — | `keyword` 搜索词；`result_count` 结果数 | 用于文档搜索使用率 |
| 文档搜索结果点击时 | — | `doc_search_result_click` 文档搜索结果点击 | `docs` 文档中心 | — | `keyword` 搜索词；`hit_slug` 命中的文档路径；`hit_rank` 命中排名 | — |

---

## 五、指标 → 事件 依赖矩阵

| # | 指标 | 优先级 | 依赖事件 | 计算口径示例 |
|---|------|:----:|--------|-----------|
| 1 | UV（日/月） | P0 | `dt_pgin`（任意页面） | `COUNT(DISTINCT user_id)` GROUP BY 日/月 |
| 2 | PV（日/月） | P0 | `dt_pgin` | `COUNT(*)` GROUP BY 日/月 |
| 3 | 访问首页 UV | P0 | `dt_pgin` WHERE `dt_pgid=home` | `COUNT(DISTINCT user_id)` |
| 4 | 进入 Account 页 UV | P1 | `dt_pgin` WHERE `dt_pgid=account` | `COUNT(DISTINCT user_id)` |
| 5 | 点击 Create Now 数 | P0 | `dt_clck` WHERE `dt_eid IN (header/hero/footer_create_now_btn)` | `COUNT(*)` |
| 6 | 进入套餐页 UV | P0 | `dt_pgin` WHERE `dt_pgid=plans` | — |
| 7 | 选择套餐 数 | P0 | `dt_clck` WHERE `dt_eid=plan_select_btn` | — |
| 8 | 发起支付 数 | P0 | `subscribe_checkout_start` | `COUNT(*)` |
| 9 | 支付成功率（护栏） | P0 | `subscribe_pay_success` / (`_success` + `_fail`) | — |
| 10 | 点击开始创建 数 | P0 | `dt_clck` WHERE `dt_eid=agent_create_start_btn` | — |
| 11 | 进入控制台 UV | P0 | `dt_pgin` WHERE `dt_pgid=agent_workbench` | — |
| 12 | 点击 Restart | P2 | `dt_clck` WHERE `dt_eid=agent_restart_btn` | — |
| 13 | 点击 Delete | P1 | `dt_clck` WHERE `dt_eid=agent_delete_btn` | — |
| 14 | 进入 Channel 页 UV | P0 | `dt_pgin` WHERE `dt_pgid=agent_channels` | — |
| 15 | 点击 Guide | P1 | `dt_clck` WHERE `dt_eid=channel_guide_btn` | — |
| 16 | 点击 Connect | P0 | `dt_clck` WHERE `dt_eid=channel_connect_btn` | — |
| 17 | 通道连接数 | P0 | `channel_connect_success` | `COUNT(*)` GROUP BY `channel_type` |
| 18 | 进入 Model 页 UV | P1 | `dt_pgin` WHERE `dt_pgid=agent_models` | — |
| 19 | 切换模型 数 | P1 | `model_switch` | — |
| 20 | 选择供应商 数 | P1 | `model_provider_select` | GROUP BY `provider` |
| 21 | 添加 API Key 数 | P2 | `model_api_key_add` | — |
| 22 | 添加自定义模型 数 | P1 | `model_custom_add` | — |
| 23 | 进入 Skills 页 UV | P1 | `dt_pgin` WHERE `dt_pgid=agent_skills` | — |
| 24 | 搜索技能 数 | P2 | `skill_search` | — |
| 25 | 安装技能 数 | P1 | `skill_install_success` | — |
| 26 | 点击技能包 数 | P2 | `dt_clck` WHERE `dt_eid=skill_pack_card` | — |
| 27 | 安装技能包 数 | P1 | `skill_pack_install_success` | — |
| 28 | 进入 Soul 页 UV | P2 | `dt_pgin` WHERE `dt_pgid=agent_persona` | — |
| 29 | 点击抽取 数 | P2 | `dt_clck` WHERE `dt_eid=persona_draw_btn` | — |
| 30 | 选择 Soul 数 | P2 | `dt_clck` WHERE `dt_eid=persona_select_card` | — |
| 31 | 注入成功 数 | P1 | `persona_inject_success` | — |
| 32 | 进入 Automations 页 UV | P1 | `dt_pgin` WHERE `dt_pgid=agent_automations` | — |
| 33 | 打开模板 数 | P2 | `dt_clck` WHERE `dt_eid=automation_template_card` | — |
| 34 | 创建任务 数 | P1 | `automation_create_success` | — |
| 35 | 删除任务 数 | P2 | `automation_delete` | — |
| 36 | 进入 Memory 页 UV | P2 | `dt_pgin` WHERE `dt_pgid=agent_memory` | — |
| 37 | 更新限额 数 | P2 | `memory_quota_update` | — |
| 38 | 进入 Storage 页 UV | P2 | `dt_pgin` WHERE `dt_pgid=agent_files` | — |
| 39 | 进入 Diagnostics 页 UV | P2 | `dt_pgin` WHERE `dt_pgid=agent_diagnostics` | — |
| 40 | 执行操作 数 | P1 | `diagnostics_action` | GROUP BY `action` |
| ★ | 周活跃 AI 对话账号数（North Star） | P0 | `agent_message_send` | `COUNT(DISTINCT user_id)` per week |

---

## 六、代码落点清单（Stage 5B 实施用）

| 埋点点位 | 目标文件 | 实现方式 |
|--------|--------|--------|
| SDK 初始化、公参回调 | `src/observability/dt-tracker.ts`（**新增**） | 代码打点入口 |
| 全局路由 → `dt_pgin`/`dt_pgout` | `src/app/layout.next.tsx` + Next 路由钩子 | 声明式（自动） |
| Create Now 三处按钮 | `next-site/public-header-auth-island.tsx`、`src/pages/marketing/landing/hero-section.tsx`、`src/pages/marketing/landing/cta-footer-section.tsx` | 声明式：加 `data-dt-eid` 属性 |
| Login 全流程 | `src/components/site/login-modal.tsx`、`src/contexts/session-context.tsx` | 代码打点 |
| 订阅漏斗 | `next-site/subscribe-page.tsx`、`src/components/domain/plan-card.tsx` | 代码打点 + 声明式混合 |
| Agent 首页操作 | `next-site/agents-page-client.tsx`（含 Restart/Delete/Enter/Create） | 代码打点 |
| 各 section 页面 | `next-site/agent-*-panel.tsx`（Channel、Model、Skills、Persona、Automations、Memory、Files、Diagnostics） | 代码打点 |
| 会话消息 | `agentchat-lightvela-panel` 集成层 | 代码打点 |
| 文档搜索 | `src/components/docs/docs-search.tsx` | 代码打点 |

---

## 七、待用户 ack

请对以下内容进行确认，ack 后进入 Stage 5B（代码生成 & SDK 接入）：

1. **页面 `dt_pgid` 命名**是否 OK（尤其 Storage → `agent_files`、Soul → `agent_persona`）
2. **North Star 指标**是否保留"周活跃 AI 对话账号数"，即需要加打 `agent_message_send`
3. **登录三事件**是否需要（用户清单未列，但会决定登录漏斗质量）
4. **文档搜索事件**是否需要（可选）
5. Agent 会话消息成功/失败是否需要（护栏指标依赖）

如全部保留 → 直接回复"ack，继续 Stage 5B"。  
如需调整 → 例如"去掉登录三事件"、"North Star 改为 XX"。
