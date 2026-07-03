## 埋点事件表

### 公共参数（每个事件自动携带，由 SDK publicParams 注入）

| 参数 key | 说明 | 取值示例 | 采集时机 |
|--------|------|--------|--------|
| `user_id` | 登录后的用户 UID；未登录留空 | `usr_xxx` | SDK 全局 setUserId |
| `app_region` | 部署区域（编译期常量，打包时注入） | `cn` / `global` | 由 `VITE_REGION` / `NEXT_PUBLIC_REGION` 注入 |
| `app_site` | 品牌+区域标识，便于看板直筛 | `lightvela-cn` / `lightvela-global` | 由 `app_region` 派生 |
| `app_surface` | 前端 surface | `lightvela-web` | SDK 初始化时注入 |
| `ref_from` | URL `?from=xxx` 捕获的外部来源 | `discord` / `twitter` / `kol_xxx` | 首次进入站点时从 URL 读取，存 sessionStorage（30 天过期） |
| `utm_source` | 标准 UTM 来源 | `google` / `newsletter` | 同上 |
| `utm_medium` | 标准 UTM 媒介 | `cpc` / `email` | 同上 |
| `utm_campaign` | 标准 UTM 活动 | `summer_launch` | 同上 |
| `page_name` | 页面英文标识（等同 `dt_pgid`，冗余便于分析） | `home` / `subscribe` | SDK 页面事件自动填充 |

> ⚠️ 公参统一在 SDK 初始化的 `publicParams` 里注入，业务代码调用埋点 API 时**不需要**手动传入。
> `ref_from` / `utm_*` 来源参数在首次进入站点时从 URL 捕获并存入 sessionStorage，
> 站内跳转不丢失；SDK 初始化成功后会立即发一条 `landing_referral` 事件确保来源数据不丢。

### 事件表

| 触发时机 trigger | 示意图 ui | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|----------|:----:|---------|---------|:------------:|-------|-------|
| 路由进入首页时 | — | `dt_pgin` 页面曝光 | `home` 首页 | — | `page_name` 页面名称标识 | 覆盖 `/` 与 `/[lang]` |
| 路由离开首页时 | — | `dt_pgout` 页面结束曝光 | `home` 首页 | — | `page_name` 页面名称标识；`dt_lvtm` 页面停留时长(ms) | — |
| 路由进入 About 页时 | — | `dt_pgin` 页面曝光 | `about` 关于我们 | — | `page_name` 页面名称标识 | — |
| 路由离开 About 页时 | — | `dt_pgout` 页面结束曝光 | `about` 关于我们 | — | `page_name` 页面名称标识；`dt_lvtm` 页面停留时长(ms) | — |
| 路由进入 Changelog 页时 | — | `dt_pgin` 页面曝光 | `changelog` 更新日志 | — | `page_name` 页面名称标识 | — |
| 路由离开 Changelog 页时 | — | `dt_pgout` 页面结束曝光 | `changelog` 更新日志 | — | `page_name` 页面名称标识；`dt_lvtm` 页面停留时长(ms) | — |
| 路由进入文档页时 | — | `dt_pgin` 页面曝光 | `docs` 文档中心 | — | `page_name` 页面名称标识；`doc_slug` 文档路径 | 由 `[[...slug]]` 提供 |
| 路由离开文档页时 | — | `dt_pgout` 页面结束曝光 | `docs` 文档中心 | — | `page_name` 页面名称标识；`doc_slug` 文档路径；`dt_lvtm` 页面停留时长(ms) | — |
| 路由进入 Cookie 政策页时 | — | `dt_pgin` 页面曝光 | `cookie_policy` Cookie 政策 | — | `page_name` 页面名称标识 | — |
| 路由进入隐私政策页时 | — | `dt_pgin` 页面曝光 | `privacy_policy` 隐私政策 | — | `page_name` 页面名称标识 | — |
| 路由进入开源许可页时 | — | `dt_pgin` 页面曝光 | `open_source_licenses` 开源许可 | — | `page_name` 页面名称标识 | — |
| 路由进入套餐选择页时 | — | `dt_pgin` 页面曝光 | `plans` 套餐选择页 | — | `page_name` 页面名称标识 | 用户核心指标"进入套餐页" |
| 路由离开套餐选择页时 | — | `dt_pgout` 页面结束曝光 | `plans` 套餐选择页 | — | `page_name` 页面名称标识；`dt_lvtm` 页面停留时长(ms) | — |
| 路由进入套餐比对页时 | — | `dt_pgin` 页面曝光 | `plan_select` 套餐比对页 | — | `page_name` 页面名称标识 | — |
| 路由进入支付页时 | — | `dt_pgin` 页面曝光 | `subscribe` 支付页 | — | `page_name` 页面名称标识；`plan` 套餐编码；`billing_period` 计费周期 | — |
| 路由离开支付页时 | — | `dt_pgout` 页面结束曝光 | `subscribe` 支付页 | — | `page_name` 页面名称标识；`dt_lvtm` 页面停留时长(ms) | — |
| 路由进入账户中心页时 | — | `dt_pgin` 页面曝光 | `account` 账户中心 | — | `page_name` 页面名称标识 | 用户核心指标"进入 Account 页" |
| 路由离开账户中心页时 | — | `dt_pgout` 页面结束曝光 | `account` 账户中心 | — | `page_name` 页面名称标识；`dt_lvtm` 页面停留时长(ms) | — |
| 路由进入我的订单页时 | — | `dt_pgin` 页面曝光 | `account_orders` 我的订单 | — | `page_name` 页面名称标识 | — |
| 路由进入 Agent 首页时 | — | `dt_pgin` 页面曝光 | `agents_home` Agent 首页 | — | `page_name` 页面名称标识；`bots_count` 已有 Bot 数量 | — |
| 路由进入 Agent 创建向导页时 | — | `dt_pgin` 页面曝光 | `agent_creating` Agent 创建向导 | — | `page_name` 页面名称标识；`entry` 入口来源 | 由 `?creating=true` 触发 |
| 路由进入 Agent 工作台页时 | — | `dt_pgin` 页面曝光 | `agent_workbench` Agent 工作台 | — | `page_name` 页面名称标识；`bot_id` Agent ID | 用户核心指标"进入控制台" |
| 路由离开 Agent 工作台页时 | — | `dt_pgout` 页面结束曝光 | `agent_workbench` Agent 工作台 | — | `page_name` 页面名称标识；`bot_id` Agent ID；`dt_lvtm` 页面停留时长(ms) | — |
| 路由进入 Agent 会话页时 | — | `dt_pgin` 页面曝光 | `agent_chat` Agent 会话页 | — | `page_name` 页面名称标识；`bot_id` Agent ID | — |
| 路由进入 Channels 页时 | — | `dt_pgin` 页面曝光 | `agent_channels` IM 通道页 | — | `page_name` 页面名称标识；`bot_id` Agent ID | 用户核心指标"进入 Channel 页" |
| 路由进入 Models 页时 | — | `dt_pgin` 页面曝光 | `agent_models` 模型配置页 | — | `page_name` 页面名称标识；`bot_id` Agent ID | 用户核心指标"进入 Model 页" |
| 路由进入 Skills 页时 | — | `dt_pgin` 页面曝光 | `agent_skills` 技能页 | — | `page_name` 页面名称标识;`bot_id` Agent ID；`sub_tab` 子 Tab | 覆盖 skills/experts/packages |
| 路由进入 Persona 页时 | — | `dt_pgin` 页面曝光 | `agent_persona` 人设页 | — | `page_name` 页面名称标识；`bot_id` Agent ID | 用户核心指标"进入 Soul 页" |
| 路由进入 Automations 页时 | — | `dt_pgin` 页面曝光 | `agent_automations` 自动任务页 | — | `page_name` 页面名称标识；`bot_id` Agent ID | — |
| 路由进入 Memory 页时 | — | `dt_pgin` 页面曝光 | `agent_memory` 记忆页 | — | `page_name` 页面名称标识；`bot_id` Agent ID | — |
| 路由进入 Files 页时 | — | `dt_pgin` 页面曝光 | `agent_files` 云存储页 | — | `page_name` 页面名称标识；`bot_id` Agent ID | 用户核心指标"进入 Storage 页" |
| 路由进入 Diagnostics 页时 | — | `dt_pgin` 页面曝光 | `agent_diagnostics` 诊断页 | — | `page_name` 页面名称标识；`bot_id` Agent ID | — |
| 用户点击首页顶栏 Create Now 按钮时 | — | `dt_clck` 元素点击 | `home` 首页 | `header_create_now_btn` | `has_bots` 是否已有 Bot；`target` 跳转目标 | 位于 `public-header-auth-island.tsx` |
| 用户点击首页 Hero 区 Create Now 按钮时 | — | `dt_clck` 元素点击 | `home` 首页 | `hero_create_now_btn` | `has_bots` 是否已有 Bot；`target` 跳转目标 | 位于 `hero-section.tsx` |
| 用户点击首页底部 CTA Create Now 按钮时 | — | `dt_clck` 元素点击 | `home` 首页 | `footer_create_now_btn` | `has_bots` 是否已有 Bot；`target` 跳转目标 | 位于 `cta-footer-section.tsx` |
| 用户点击顶栏 Login 按钮时 | — | `dt_clck` 元素点击 | `home` 首页 | `header_login_btn` | — | — |
| 用户点击顶栏 Docs 入口时 | — | `dt_clck` 元素点击 | `home` 首页 | `header_docs_link` | — | — |
| 用户点击顶栏 Pricing 入口时 | — | `dt_clck` 元素点击 | `home` 首页 | `header_pricing_link` | — | — |
| 用户切换语言时 | — | `dt_clck` 元素点击 | `home` 首页 | `language_switcher_btn` | `from_locale` 原语言；`to_locale` 目标语言 | — |
| 套餐卡片首次进入视口时 | — | `dt_imp` 元素曝光 | `plans` 套餐选择页 | `plan_card` | `plan` 套餐编码；`billing_period` 计费周期 | 用于 CTR 分析 |
| 套餐卡片离开视口时 | — | `dt_imp_end` 元素结束曝光 | `plans` 套餐选择页 | `plan_card` | `plan` 套餐编码；`view_duration` 曝光时长(ms) | — |
| 用户点击套餐卡片选择按钮时 | — | `dt_clck` 元素点击 | `plans` 套餐选择页 | `plan_select_btn` | `plan` 套餐编码；`billing_period` 计费周期 | 用户核心指标"选择套餐" |
| 用户切换套餐周期(月/年)时 | — | `dt_clck` 元素点击 | `plans` 套餐选择页 | `billing_period_toggle` | `to_period` 目标周期 | — |
| 用户点击支付页立即支付按钮时 | — | `dt_clck` 元素点击 | `subscribe` 支付页 | `pay_now_btn` | `plan` 套餐编码；`billing_period` 计费周期；`pay_channel` 支付渠道 | 用户核心指标"发起支付"配套点击 |
| 用户点击账户中心侧栏订单入口时 | — | `dt_clck` 元素点击 | `account` 账户中心 | `orders_entry_link` | — | — |
| 用户点击 Agent 首页开始创建按钮时 | — | `dt_clck` 元素点击 | `agents_home` Agent 首页 | `agent_create_start_btn` | `bots_count` 现有 Bot 数量 | 用户核心指标"点击开始创建" |
| 用户点击 Agent 卡片进入控制台按钮时 | — | `dt_clck` 元素点击 | `agents_home` Agent 首页 | `agent_enter_console_btn` | `bot_id` Agent ID；`bot_status` Bot 状态 | — |
| 用户点击 Agent 卡片 Restart 按钮时 | — | `dt_clck` 元素点击 | `agents_home` Agent 首页 | `agent_restart_btn` | `bot_id` Agent ID | 用户 P2 指标"点击 Restart" |
| 用户点击 Agent 卡片 Delete 按钮时 | — | `dt_clck` 元素点击 | `agents_home` Agent 首页 | `agent_delete_btn` | `bot_id` Agent ID | 用户 P1 指标"点击 Delete" |
| 用户点击 Channels 页 Guide 按钮时 | — | `dt_clck` 元素点击 | `agent_channels` IM 通道页 | `channel_guide_btn` | `bot_id` Agent ID；`channel_type` 通道类型 | 用户 P1 指标"点击 Guide" |
| 用户点击 Channels 页 Connect 按钮时 | — | `dt_clck` 元素点击 | `agent_channels` IM 通道页 | `channel_connect_btn` | `bot_id` Agent ID；`channel_type` 通道类型(telegram/discord/wechat/whatsapp) | 用户 P0 指标"点击 Connect" |
| 用户聚焦 Skills 页搜索框时 | — | `dt_clck` 元素点击 | `agent_skills` 技能页 | `skills_search_input` | `bot_id` Agent ID | — |
| 用户点击技能卡片时 | — | `dt_clck` 元素点击 | `agent_skills` 技能页 | `skill_item_card` | `bot_id` Agent ID；`skill_id` 技能 ID；`skill_name` 技能名 | — |
| 用户点击技能包卡片时 | — | `dt_clck` 元素点击 | `agent_skills` 技能页 | `skill_pack_card` | `bot_id` Agent ID；`pack_id` 技能包 ID | 用户 P2 指标"点击技能包" |
| 用户点击 Persona 抽取按钮时 | — | `dt_clck` 元素点击 | `agent_persona` 人设页 | `persona_draw_btn` | `bot_id` Agent ID | 用户 P2 指标"点击抽取" |
| 用户点击 Persona 卡片选择时 | — | `dt_clck` 元素点击 | `agent_persona` 人设页 | `persona_select_card` | `bot_id` Agent ID；`persona_id` 人设 ID | 用户 P2 指标"选择 Soul" |
| 用户点击 Automations 模板卡片时 | — | `dt_clck` 元素点击 | `agent_automations` 自动任务页 | `automation_template_card` | `bot_id` Agent ID；`template_id` 模板 ID | 用户 P2 指标"打开模板" |
| 用户点击登录按钮开始登录流程时 | — | `login_attempt` 登录发起 | `home` 首页 | — | `method` 登录方式(wechat/github/email) | 位于 `login-modal.tsx` |
| 登录成功回调时 | — | `login_success` 登录成功 | — | — | `method` 登录方式；`is_new_user` 是否新用户 | 与页面无关 |
| 登录失败回调时 | — | `login_fail` 登录失败 | — | — | `method` 登录方式；`error_code` 错误码；`error_msg` 错误消息 | — |
| 支付页发起支付调用时 | — | `subscribe_checkout_start` 发起支付 | `subscribe` 支付页 | — | `plan` 套餐编码；`billing_period` 计费周期；`pay_channel` 支付渠道；`amount` 金额；`currency` 币种 | 用户核心指标"发起支付" |
| 支付回调成功时 | — | `subscribe_pay_success` 支付成功 | `subscribe` 支付页 | — | `plan` 套餐编码；`billing_period` 计费周期；`pay_channel` 支付渠道；`amount` 金额；`order_id` 订单号 | — |
| 支付失败或取消时 | — | `subscribe_pay_fail` 支付失败 | `subscribe` 支付页 | — | `plan` 套餐编码；`pay_channel` 支付渠道；`fail_reason` 失败原因；`error_code` 错误码 | — |
| Agent 创建接口成功返回时 | — | `agent_create_success` Agent 创建成功 | `agent_creating` Agent 创建向导 | — | `bot_id` 新 Agent ID；`create_duration_ms` 创建耗时(ms) | 判断激活漏斗 |
| Agent 创建失败时 | — | `agent_create_fail` Agent 创建失败 | `agent_creating` Agent 创建向导 | — | `error_code` 错误码；`error_msg` 错误消息 | — |
| IM 通道连接接口返回成功时 | — | `channel_connect_success` 通道连接成功 | `agent_channels` IM 通道页 | — | `bot_id` Agent ID；`channel_type` 通道类型 | 用户 P0 指标"通道连接数" |
| Model 切换成功时 | — | `model_switch` 模型切换 | `agent_models` 模型配置页 | — | `bot_id` Agent ID；`from_model` 原模型；`to_model` 目标模型；`provider` 供应商 | 用户 P1 指标"切换模型" |
| 供应商选择完成时 | — | `model_provider_select` 选择供应商 | `agent_models` 模型配置页 | — | `bot_id` Agent ID；`provider` 供应商 | 用户 P1 指标"选择供应商" |
| API Key 保存成功时 | — | `model_api_key_add` 添加 API Key | `agent_models` 模型配置页 | — | `bot_id` Agent ID；`provider` 供应商 | 用户 P2 指标"添加 API Key"，参数不包含 key 明文 |
| 自定义模型保存成功时 | — | `model_custom_add` 添加自定义模型 | `agent_models` 模型配置页 | — | `bot_id` Agent ID；`model_name` 自定义模型名；`endpoint_type` 接口类型 | 用户 P1 指标"添加自定义模型" |
| Skills 页搜索接口调用时 | — | `skill_search` 技能搜索 | `agent_skills` 技能页 | — | `bot_id` Agent ID；`keyword` 搜索词；`result_count` 结果数 | 用户 P2 指标"搜索技能" |
| 技能安装成功时 | — | `skill_install_success` 技能安装成功 | `agent_skills` 技能页 | — | `bot_id` Agent ID；`skill_id` 技能 ID；`skill_name` 技能名 | 用户 P1 指标"安装技能" |
| 技能包安装成功时 | — | `skill_pack_install_success` 技能包安装成功 | `agent_skills` 技能页 | — | `bot_id` Agent ID；`pack_id` 技能包 ID；`skill_count` 包内技能数 | 用户 P1 指标"安装技能包" |
| Persona 注入接口成功时 | — | `persona_inject_success` 人设注入成功 | `agent_persona` 人设页 | — | `bot_id` Agent ID；`persona_id` 人设 ID；`persona_source` 来源(draw/manual) | 用户 P1 指标"注入成功" |
| Persona 注入失败时 | — | `persona_inject_fail` 人设注入失败 | `agent_persona` 人设页 | — | `bot_id` Agent ID；`error_code` 错误码 | — |
| 自动任务创建接口成功时 | — | `automation_create_success` 自动任务创建 | `agent_automations` 自动任务页 | — | `bot_id` Agent ID；`task_id` 任务 ID；`schedule_type` 调度类型(cron/interval/once) | 用户 P1 指标"创建任务" |
| 自动任务删除成功时 | — | `automation_delete` 自动任务删除 | `agent_automations` 自动任务页 | — | `bot_id` Agent ID；`task_id` 任务 ID | 用户 P2 指标"删除任务" |
| Memory 限额更新接口成功时 | — | `memory_quota_update` 记忆限额更新 | `agent_memory` 记忆页 | — | `bot_id` Agent ID；`old_quota` 原限额；`new_quota` 新限额 | 用户 P2 指标"更新限额" |
| Diagnostics 执行操作触发时 | — | `diagnostics_action` 诊断操作 | `agent_diagnostics` 诊断页 | — | `bot_id` Agent ID；`action` 操作类型(restart/log_pull/env_reset 等) | 用户 P1 指标"执行操作" |
| AI 会话消息发送成功时 | — | `agent_message_send` Agent 消息发送 | `agent_chat` Agent 会话页 | — | `bot_id` Agent ID；`msg_len` 消息长度；`session_id` 会话 ID；`model` 使用模型 | North Star 指标依赖 |
| AI 会话消息失败时 | — | `agent_message_fail` Agent 消息失败 | `agent_chat` Agent 会话页 | — | `bot_id` Agent ID；`session_id` 会话 ID；`error_code` 错误码；`error_msg` 错误消息 | 护栏指标 |
| 文档搜索接口触发时 | — | `doc_search` 文档搜索 | `docs` 文档中心 | — | `keyword` 搜索词；`result_count` 结果数 | 用于文档搜索使用率 |
| 文档搜索结果点击时 | — | `doc_search_result_click` 文档搜索结果点击 | `docs` 文档中心 | — | `keyword` 搜索词；`hit_slug` 命中的文档路径；`hit_rank` 命中排名 | — |
| SDK 初始化成功且 URL 含来源参数时 | — | `landing_referral` 来源捕获 | — | — | `ref_from` 来源渠道；`utm_source` UTM 来源；`utm_medium` UTM 媒介；`utm_campaign` UTM 活动 | 捕获外部渠道引流（discord/twitter/kol 等），SDK init 后立即上报，避免用户未跳转就离开导致来源丢失 |
