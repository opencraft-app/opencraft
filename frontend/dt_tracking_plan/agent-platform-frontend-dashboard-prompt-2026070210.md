这个知识库里包含 Hermes AI Agent 平台（agent-platform-frontend）的埋点明细数据。请基于明细数据和以下信息，生成看板图卡。（这些埋点才刚实现，线上可能还没有正式上报数据，所以查询无数据属于正常现象。）
======

## 一、埋点方案

### 约定说明
- **事件（event_code）** 是上报事件名，英文命名，表中 `中文 / english` 对照。
- **页面（dt_pgid）** 标识所在页面。
- **元素（dt_eid）** 标识交互元素。
- **私有参数（udf_kv）** 为事件携带的上下文参数，多个参数用分号分隔，格式为 `字段名` 中文名。udf_kv 是导入和管理层面的概念，分析时使用其下的具体 key 名。
- 触发时机列说明含义：`pv` = 页面可见，`click` = 点击，`change` = 切换/变更，`submit` = 表单提交，`expose` = 曝光。

---

### 1. 全局导航 & 页面浏览（覆盖所有页面）

| 触发时机 | 示意图 | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|---------|:----:|----------------|-------------|:----------:|----------------|-------------|
| pv（路由进入） | — | 页面曝光 / `dt_pgin` | 当前页面ID / `{pgid}` | — | `pgid` 页面标识；`ref_page_id` 来源页面ID | SDK 自动采集；pgid 由 datong-page-map 派发 |
| pv（路由离开） | — | 页面结束曝光 / `dt_pgout` | 当前页面ID / `{pgid}` | — | `pgid` 页面标识；`dt_lvtm` 停留时长ms | SDK 自动采集 |
| click | — | 元素点击 / `dt_clck` | 当前页面ID / `{pgid}` | 元素标识 / `{dt_eid}` | — | SDK 自动采集，通过 dt-eid 标记元素 |
| expose | — | 元素曝光 / `dt_imp` | 当前页面ID / `{pgid}` | 元素标识 / `{dt_eid}` | — | 声明式 |
| expose（离开视口） | — | 元素结束曝光 / `dt_imp_end` | 当前页面ID / `{pgid}` | 元素标识 / `{dt_eid}` | — | 声明式 |

---

### 2. 公开站首页 & CTA

| 触发时机 | 示意图 | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|---------|:----:|----------------|-------------|:----------:|----------------|-------------|
| pv（路由进入） | — | 首页曝光 / `dt_pgin` | 首页 / `home` | — | — | Landing Page |
| click | — | Hero Create Now 点击 / `dt_clck` | 首页 / `home` | Hero CTA / `hero_create_now_btn` | `location` 位置=hero | landing-page.tsx 主视觉按钮 |
| click | — | 顶栏 Create Now 点击 / `dt_clck` | 当前页面ID / `{pgid}` | 顶栏 CTA / `header_create_now_btn` | `location` 位置=header | 未登录态顶栏按钮 |
| click | — | 顶栏 Login 点击 / `dt_clck` | 当前页面ID / `{pgid}` | 顶栏登录 / `header_login_btn` | — | 未登录态顶栏按钮 |
| click | — | 底部 Create Now 点击 / `dt_clck` | 首页 / `home` | 底部 CTA / `footer_create_now_btn` | `location` 位置=footer | landing-page.tsx 底部再营销按钮 |

---

### 3. 登录 & 注册

| 触发时机 | 示意图 | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|---------|:----:|----------------|-------------|:----------:|----------------|-------------|
| submit | — | 登录发起 / `login_attempt` | 当前页面ID / `{pgid}` | — | `method` 登录方式(email\|google\|wallet) | 手动上报 |
| submit | — | 登录成功 / `login_success` | 当前页面ID / `{pgid}` | — | `method` 登录方式；`is_new_user` 是否新用户 | login-modal.tsx 内已埋 |
| submit | — | 登录失败 / `login_fail` | 当前页面ID / `{pgid}` | — | `method` 渠道；`error_code` 错误码 | 手动上报 |

---

### 4. 订阅与商业化漏斗

| 触发时机 | 示意图 | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|---------|:----:|----------------|-------------|:----------:|----------------|-------------|
| pv（路由进入） | — | 套餐页曝光 / `dt_pgin` | 订阅页 / `subscribe` | — | — | /subscribe 路由 |
| click | — | 选择套餐 / `dt_clck` | 订阅页 / `subscribe` | 套餐卡片 / `plan_select_btn` | `plan` 套餐ID；`plan_name` 套餐名 | 声明式 |
| submit | — | 发起支付 / `subscribe_checkout_start` | 订阅页 / `subscribe` | — | `plan` 套餐ID；`plan_name` 套餐名 | subscribe-page.tsx 已埋 |
| submit | — | 支付成功 / `subscribe_pay_success` | 订阅页 / `subscribe` | — | `plan` 套餐ID；`plan_name` 套餐名；`amount` 金额 | subscribe-page.tsx 已埋 |
| submit | — | 支付失败 / `subscribe_pay_fail` | 订阅页 / `subscribe` | — | `plan` 套餐ID；`error_code` 错误码 | 待补埋点 |

---

### 5. Agent 创建 & 控制台入口

| 触发时机 | 示意图 | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|---------|:----:|----------------|-------------|:----------:|----------------|-------------|
| pv（路由进入） | — | Agents 首页曝光 / `dt_pgin` | Agents 首页 / `agents_home` | — | — | /agents 路由 |
| click | — | 点击开始创建 / `dt_clck` | Agents 首页 / `agents_home` | 创建按钮 / `create_agent_btn` | — | 声明式 |
| pv（路由进入） | — | 创建页曝光 / `dt_pgin` | 创建 Agent / `agent_creating` | — | — | /agents/confirm-create |
| submit | — | Agent 创建成功 / `agent_create_success` | 当前页面ID / `{pgid}` | — | `agent_id` AgentID；`create_duration_ms` 创建耗时；`entry` 入口=subscribe\|confirm-create | agent-settings-page.tsx 已埋 |
| submit | — | Agent 创建失败 / `agent_create_fail` | 当前页面ID / `{pgid}` | — | `err_code` 错误码 | 待补埋点 |
| pv（路由进入） | — | 控制台曝光 / `dt_pgin` | Agent 控制台 / `agent_workbench` | — | `agent_id` AgentID | /agents/[id] 主页 |
| click | — | Restart Agent 点击 / `dt_clck` | Agent 控制台 / `agent_workbench` | Restart / `agent_restart_btn` | `agent_id` AgentID | 声明式 |
| click | — | Delete Agent 点击 / `dt_clck` | Agent 控制台 / `agent_workbench` | Delete / `agent_delete_btn` | `agent_id` AgentID | 声明式 |

---

### 6. Agent Section - Channel（IM 连接）

| 触发时机 | 示意图 | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|---------|:----:|----------------|-------------|:----------:|----------------|-------------|
| pv（路由进入） | — | Channel 页曝光 / `dt_pgin` | Channel / `agent_channels` | — | `agent_id` AgentID | /agents/[id]/channels |
| click | — | Guide 点击 / `dt_clck` | Channel / `agent_channels` | Guide / `channel_guide_btn` | `channel_type` 渠道类型 | 声明式 |
| click | — | Connect 点击 / `dt_clck` | Channel / `agent_channels` | Connect / `channel_connect_btn` | `channel_type` telegram\|discord\|wechat\|whatsapp | 声明式 |
| submit | — | 通道连接成功 / `channel_connect_success` | Channel / `agent_channels` | — | `agent_id` AgentID；`channel_type` 渠道类型 | 待补埋点 |

---

### 7. Agent Section - Model（模型配置）

| 触发时机 | 示意图 | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|---------|:----:|----------------|-------------|:----------:|----------------|-------------|
| pv（路由进入） | — | Model 页曝光 / `dt_pgin` | Model / `agent_models` | — | `agent_id` AgentID | /agents/[id]/models |
| change | — | 切换模型 / `model_switch` | Model / `agent_models` | — | `agent_id` AgentID；`model_name` 模型名 | 待补埋点 |
| change | — | 选择供应商 / `model_provider_select` | Model / `agent_models` | — | `provider` 供应商=openai\|anthropic\|... | 待补埋点 |
| submit | — | 添加 API Key / `model_apikey_add` | Model / `agent_models` | — | `provider` 供应商 | 待补埋点 |
| submit | — | 添加自定义模型 / `model_custom_add` | Model / `agent_models` | — | `provider` 供应商；`model_name` 模型名 | 待补埋点 |

---

### 8. Agent Section - Skills（技能/技能包）

| 触发时机 | 示意图 | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|---------|:----:|----------------|-------------|:----------:|----------------|-------------|
| pv（路由进入） | — | Skills 页曝光 / `dt_pgin` | Skills / `agent_skills` | — | `agent_id` AgentID | /agents/[id]/skills |
| submit | — | 搜索技能 / `skill_search` | Skills / `agent_skills` | — | `keyword` 关键词 | 待补埋点 |
| submit | — | 安装技能 / `skill_install_success` | Skills / `agent_skills` | — | `skill_id` 技能ID；`skill_name` 技能名 | 待补埋点 |
| click | — | 点击技能包 / `dt_clck` | Skills / `agent_skills` | 技能包卡片 / `skill_pack_card` | `pack_id` 技能包ID | 声明式 |
| submit | — | 安装技能包 / `skill_pack_install_success` | Skills / `agent_skills` | — | `pack_id` 技能包ID；`pack_name` 包名 | 待补埋点 |

---

### 9. Agent Section - Persona（人设/Soul）

| 触发时机 | 示意图 | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|---------|:----:|----------------|-------------|:----------:|----------------|-------------|
| pv（路由进入） | — | Soul 页曝光 / `dt_pgin` | Persona / `agent_persona` | — | `agent_id` AgentID | /agents/[id]/persona |
| click | — | 点击抽取 / `dt_clck` | Persona / `agent_persona` | 抽取按钮 / `soul_draw_btn` | — | 声明式 |
| click | — | 选择 Soul / `dt_clck` | Persona / `agent_persona` | Soul 卡片 / `soul_select_card` | `soul_id` SoulID | 声明式 |
| submit | — | Persona 注入成功 / `persona_inject_success` | Persona / `agent_persona` | — | `agent_id` AgentID；`persona_id` PersonaID | 待补埋点 |

---

### 10. Agent Section - Automations（自动任务）

| 触发时机 | 示意图 | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|---------|:----:|----------------|-------------|:----------:|----------------|-------------|
| pv（路由进入） | — | Automations 页曝光 / `dt_pgin` | Automations / `agent_automations` | — | `agent_id` AgentID | /agents/[id]/automations |
| click | — | 打开模板 / `dt_clck` | Automations / `agent_automations` | 模板卡片 / `automation_template_card` | `template_id` 模板ID | 声明式 |
| submit | — | 创建自动任务 / `automation_create_success` | Automations / `agent_automations` | — | `agent_id` AgentID；`task_type` 任务类型 | 待补埋点 |
| submit | — | 删除自动任务 / `automation_delete` | Automations / `agent_automations` | — | `task_id` 任务ID | 待补埋点 |

---

### 11. Agent Section - Memory / Storage / Diagnostics

| 触发时机 | 示意图 | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|---------|:----:|----------------|-------------|:----------:|----------------|-------------|
| pv（路由进入） | — | Memory 页曝光 / `dt_pgin` | Memory / `agent_memory` | — | `agent_id` AgentID | /agents/[id]/memory |
| submit | — | 更新记忆限额 / `memory_quota_update` | Memory / `agent_memory` | — | `quota` 新限额值 | 待补埋点 |
| pv（路由进入） | — | Storage 页曝光 / `dt_pgin` | Storage / `agent_files` | — | `agent_id` AgentID | /agents/[id]/files |
| pv（路由进入） | — | Diagnostics 页曝光 / `dt_pgin` | Diagnostics / `agent_diagnostics` | — | `agent_id` AgentID | /agents/[id]/diagnostics |
| click | — | 执行诊断操作 / `diagnostics_action` | Diagnostics / `agent_diagnostics` | 操作按钮 / `diagnostics_action_btn` | `action` 操作类型=restart\|logs\|health | 声明式+代码打点 |

---

### 12. Agent 会话 / Docs

| 触发时机 | 示意图 | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|---------|:----:|----------------|-------------|:----------:|----------------|-------------|
| pv（路由进入） | — | 会话页曝光 / `dt_pgin` | Agent 会话 / `agent_chat` | — | `agent_id` AgentID | /agents/[id]/chat |
| submit | — | 发送消息 / `agent_message_send` | Agent 会话 / `agent_chat` | — | `agent_id` AgentID；`msg_len` 消息长度 | 待补埋点（North Star 依赖） |
| submit | — | 消息发送成功 / `agent_message_send_success` | Agent 会话 / `agent_chat` | — | `agent_id` AgentID；`latency_ms` 响应耗时 | 待补埋点 |
| submit | — | 消息发送失败 / `agent_message_send_fail` | Agent 会话 / `agent_chat` | — | `agent_id` AgentID；`err_code` 错误码 | 待补埋点（护栏） |
| pv（路由进入） | — | Docs 页曝光 / `dt_pgin` | 文档中心 / `docs` | — | `doc_slug` 文档标识 | /docs 路由 |
| submit | — | Docs 搜索 / `doc_search` | 文档中心 / `docs` | — | `keyword` 关键词；`result_count` 结果数 | 待补埋点 |
| click | — | Docs 搜索结果点击 / `dt_clck` | 文档中心 / `docs` | 搜索结果 / `docs_search_result` | `keyword` 关键词；`doc_slug` 文档标识 | 声明式 |

---

### 13. Account 页

| 触发时机 | 示意图 | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|---------|:----:|----------------|-------------|:----------:|----------------|-------------|
| pv（路由进入） | — | Account 页曝光 / `dt_pgin` | Account / `account` | — | — | /account 路由 |

---

## 二、看板方案

### 看板 1：全局流量与转化漏斗（Growth Board）

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                      📊 Hermes 全局流量与转化漏斗 Dashboard                            │
├─────────────────────┬─────────────────────┬─────────────────────┬───────────────────┤
│ 📈 今日 UV          │ 📈 今日 PV          │ 📈 今日新增账号数   │ 📈 周活跃对话账号 │
│ 独立访客数           │ 页面浏览总量         │ 首次登录成功用户    │ WAU-Chatting      │
├─────────────────────┴─────────────────────┴─────────────────────┴───────────────────┤
│                                                                                     │
│  📉 UV / PV / 登录用户 · 30 天趋势（多线折线图）                                        │
│                                                                                     │
├─────────────────────────────────────────────┬───────────────────────────────────────┤
│ 🔻 首页 → 订阅 → Agent 创建 · 转化漏斗       │ 🥧 Create Now CTA 位置分布            │
│                                             │ (hero / header / footer 三处)         │
├─────────────────────────────────────────────┼───────────────────────────────────────┤
│ 📊 TOP 页面（按 PV）                         │ 📊 TOP 页面（按平均停留时长）         │
└─────────────────────────────────────────────┴───────────────────────────────────────┘
```

**图卡计算逻辑：**

| 图卡 | 计算逻辑 (伪 SQL) |
|------|-------------------|
| 今日 UV | `SELECT COUNT(DISTINCT user_id) FROM events WHERE event_code = 'dt_pgin' AND dt >= TODAY()` |
| 今日 PV | `SELECT COUNT(*) FROM events WHERE event_code = 'dt_pgin' AND dt >= TODAY()` |
| 今日新增账号数 | `SELECT COUNT(DISTINCT user_id) FROM events WHERE event_code = 'login_success' AND dt >= TODAY()` |
| 周活跃对话账号（North Star） | `SELECT COUNT(DISTINCT user_id) FROM events WHERE event_code = 'agent_message_send' AND dt >= DATE_SUB(TODAY(), 7)` |
| 30 天趋势 UV | `SELECT dt, COUNT(DISTINCT user_id) AS uv FROM events WHERE event_code = 'dt_pgin' AND dt >= DATE_SUB(TODAY(), 30) GROUP BY dt ORDER BY dt` |
| 30 天趋势 PV | `SELECT dt, COUNT(*) AS pv FROM events WHERE event_code = 'dt_pgin' AND dt >= DATE_SUB(TODAY(), 30) GROUP BY dt ORDER BY dt` |
| 30 天趋势 登录成功 | `SELECT dt, COUNT(*) AS logins FROM events WHERE event_code = 'login_success' AND dt >= DATE_SUB(TODAY(), 30) GROUP BY dt ORDER BY dt` |
| 转化漏斗 - 首页 UV | `SELECT COUNT(DISTINCT user_id) FROM events WHERE event_code = 'dt_pgin' AND dt_pgid = 'home' AND dt >= DATE_SUB(TODAY(), 7)` |
| 转化漏斗 - 订阅页 UV | `SELECT COUNT(DISTINCT user_id) FROM events WHERE event_code = 'dt_pgin' AND dt_pgid = 'subscribe' AND dt >= DATE_SUB(TODAY(), 7)` |
| 转化漏斗 - 订阅成功 UV | `SELECT COUNT(DISTINCT user_id) FROM events WHERE event_code = 'subscribe_pay_success' AND dt >= DATE_SUB(TODAY(), 7)` |
| 转化漏斗 - Agent 创建成功 UV | `SELECT COUNT(DISTINCT user_id) FROM events WHERE event_code = 'agent_create_success' AND dt >= DATE_SUB(TODAY(), 7)` |
| CTA 位置分布 | `SELECT dt_eid, COUNT(*) AS clicks FROM events WHERE event_code = 'dt_clck' AND dt_eid IN ('hero_create_now_btn', 'header_create_now_btn', 'footer_create_now_btn') AND dt >= DATE_SUB(TODAY(), 7) GROUP BY dt_eid` |
| TOP 页面 by PV | `SELECT dt_pgid, COUNT(*) AS pv FROM events WHERE event_code = 'dt_pgin' AND dt >= TODAY() GROUP BY dt_pgid ORDER BY pv DESC LIMIT 10` |
| TOP 页面 by 平均停留时长 | `SELECT dt_pgid, AVG(CAST(dt_lvtm AS BIGINT)) AS avg_ms FROM events WHERE event_code = 'dt_pgout' AND dt >= TODAY() GROUP BY dt_pgid ORDER BY avg_ms DESC LIMIT 10` |

**dt 是小时级分区字段，格式 `yyyyMMddHH`（如 `2026070210` = 2026年7月2日10时），注意年是要写4位，月是2位，日是2位、时是2位**

---

### 看板 2：订阅商业化漏斗（Revenue Board）

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                        💰 Hermes 订阅商业化 Dashboard                                │
├─────────────────────┬─────────────────────┬─────────────────────┬───────────────────┤
│ 📈 今日订阅成功数    │ 📈 今日付费金额     │ 📈 支付发起数        │ 📈 支付成功率     │
├─────────────────────┴─────────────────────┴─────────────────────┴───────────────────┤
│                                                                                     │
│  🔻 订阅漏斗：进入套餐页 → 选择套餐 → 发起支付 → 支付成功                              │
│                                                                                     │
├─────────────────────────────────┬───────────────────────────────────────────────────┤
│ 🥧 套餐选择分布（按 plan_name） │ 📉 订阅成功 / 支付发起 · 30 天趋势                 │
├─────────────────────────────────┼───────────────────────────────────────────────────┤
│ 📊 各套餐转化率（各档 %）        │ 📊 支付失败 TOP 原因（按 err_code）               │
└─────────────────────────────────┴───────────────────────────────────────────────────┘
```

**图卡计算逻辑：**

| 图卡 | 计算逻辑 (伪 SQL) |
|------|-------------------|
| 今日订阅成功数 | `SELECT COUNT(*) FROM events WHERE event_code = 'subscribe_pay_success' AND dt >= TODAY()` |
| 今日付费金额 | `SELECT SUM(CAST(amount AS BIGINT)) FROM events WHERE event_code = 'subscribe_pay_success' AND dt >= TODAY()` |
| 支付发起数 | `SELECT COUNT(*) FROM events WHERE event_code = 'subscribe_checkout_start' AND dt >= TODAY()` |
| 支付成功率 | `SELECT (SUM(CASE WHEN event_code = 'subscribe_pay_success' THEN 1 ELSE 0 END) * 1.0 / NULLIF(SUM(CASE WHEN event_code = 'subscribe_checkout_start' THEN 1 ELSE 0 END), 0)) AS success_rate FROM events WHERE event_code IN ('subscribe_checkout_start', 'subscribe_pay_success') AND dt >= TODAY()` |
| 漏斗 - 订阅页 UV | `SELECT COUNT(DISTINCT user_id) FROM events WHERE event_code = 'dt_pgin' AND dt_pgid = 'subscribe' AND dt >= DATE_SUB(TODAY(), 7)` |
| 漏斗 - 选择套餐 UV | `SELECT COUNT(DISTINCT user_id) FROM events WHERE event_code = 'dt_clck' AND dt_eid = 'plan_select_btn' AND dt >= DATE_SUB(TODAY(), 7)` |
| 漏斗 - 发起支付 UV | `SELECT COUNT(DISTINCT user_id) FROM events WHERE event_code = 'subscribe_checkout_start' AND dt >= DATE_SUB(TODAY(), 7)` |
| 漏斗 - 支付成功 UV | `SELECT COUNT(DISTINCT user_id) FROM events WHERE event_code = 'subscribe_pay_success' AND dt >= DATE_SUB(TODAY(), 7)` |
| 套餐选择分布 | `SELECT plan_name, COUNT(*) AS cnt FROM events WHERE event_code = 'subscribe_checkout_start' AND dt >= DATE_SUB(TODAY(), 7) GROUP BY plan_name ORDER BY cnt DESC` |
| 30 天订阅成功趋势 | `SELECT dt, COUNT(*) AS success_cnt FROM events WHERE event_code = 'subscribe_pay_success' AND dt >= DATE_SUB(TODAY(), 30) GROUP BY dt ORDER BY dt` |
| 30 天支付发起趋势 | `SELECT dt, COUNT(*) AS initiate_cnt FROM events WHERE event_code = 'subscribe_checkout_start' AND dt >= DATE_SUB(TODAY(), 30) GROUP BY dt ORDER BY dt` |
| 各套餐转化率 | `SELECT plan_name, (SUM(CASE WHEN event_code = 'subscribe_pay_success' THEN 1 ELSE 0 END) * 1.0 / NULLIF(SUM(CASE WHEN event_code = 'subscribe_checkout_start' THEN 1 ELSE 0 END), 0)) AS rate FROM events WHERE event_code IN ('subscribe_checkout_start', 'subscribe_pay_success') AND dt >= DATE_SUB(TODAY(), 30) GROUP BY plan_name` |
| 支付失败 TOP 原因 | `SELECT error_code, COUNT(*) AS cnt FROM events WHERE event_code = 'subscribe_pay_fail' AND dt >= DATE_SUB(TODAY(), 30) GROUP BY error_code ORDER BY cnt DESC LIMIT 10` |

**dt 是小时级分区字段，格式 `yyyyMMddHH`（如 `2026070210` = 2026年7月2日10时），注意年是要写4位，月是2位，日是2位、时是2位**

---

### 看板 3：Agent 使用深度与产品健康（Product Health Board）

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                    🤖 Hermes Agent 使用深度 Dashboard                                │
├─────────────────────┬─────────────────────┬─────────────────────┬───────────────────┤
│ 📈 今日新建 Agent 数  │ 📈 Agent 存活数     │ 📈 平均创建耗时(ms) │ 📈 会话消息发送量 │
├─────────────────────┴─────────────────────┴─────────────────────┴───────────────────┤
│                                                                                     │
│  📊 Agent 各 Section 访问热度（按 dt_pgid 柱状图）                                    │
│                                                                                     │
├─────────────────────────────────┬───────────────────────────────────────────────────┤
│ 📊 各 Section 平均停留时长      │ 📉 会话消息成功率 · 30 天趋势                     │
├─────────────────────────────────┼───────────────────────────────────────────────────┤
│ 📊 Docs 文档访问 TOP 10          │ 🥧 Agent 创建入口分布                             │
│                                 │ (subscribe / agent_creating)                      │
└─────────────────────────────────┴───────────────────────────────────────────────────┘
```

**图卡计算逻辑：**

| 图卡 | 计算逻辑 (伪 SQL) |
|------|-------------------|
| 今日新建 Agent 数 | `SELECT COUNT(*) FROM events WHERE event_code = 'agent_create_success' AND dt >= TODAY()` |
| Agent 存活数（进入过控制台） | `SELECT COUNT(DISTINCT agent_id) FROM events WHERE event_code = 'dt_pgin' AND dt_pgid = 'agent_workbench' AND dt >= TODAY()` |
| 平均创建耗时 | `SELECT AVG(CAST(create_duration_ms AS BIGINT)) FROM events WHERE event_code = 'agent_create_success' AND dt >= TODAY()` |
| 会话消息发送量 | `SELECT COUNT(*) FROM events WHERE event_code = 'agent_message_send' AND dt >= TODAY()` |
| Section 访问热度 | `SELECT dt_pgid, COUNT(*) AS pv FROM events WHERE event_code = 'dt_pgin' AND dt_pgid IN ('agent_workbench','agent_channels','agent_models','agent_skills','agent_persona','agent_automations','agent_memory','agent_files','agent_diagnostics','agent_chat','agent_achievement') AND dt >= TODAY() GROUP BY dt_pgid ORDER BY pv DESC` |
| 各 Section 平均停留时长 | `SELECT dt_pgid, AVG(CAST(dt_lvtm AS BIGINT)) AS avg_ms FROM events WHERE event_code = 'dt_pgout' AND dt_pgid IN ('agent_workbench','agent_channels','agent_models','agent_skills','agent_persona','agent_automations','agent_memory','agent_files','agent_diagnostics','agent_chat','agent_achievement') AND dt >= TODAY() GROUP BY dt_pgid ORDER BY avg_ms DESC` |
| 消息成功率 30 天趋势 | `SELECT dt, (SUM(CASE WHEN event_code = 'agent_message_send_success' THEN 1 ELSE 0 END) * 1.0 / NULLIF(SUM(CASE WHEN event_code = 'agent_message_send' THEN 1 ELSE 0 END), 0)) AS success_rate FROM events WHERE event_code IN ('agent_message_send', 'agent_message_send_success') AND dt >= DATE_SUB(TODAY(), 30) GROUP BY dt ORDER BY dt` |
| Docs 文档访问 TOP 10 | `SELECT doc_slug, COUNT(*) AS pv FROM events WHERE event_code = 'dt_pgin' AND dt_pgid = 'docs' AND dt >= DATE_SUB(TODAY(), 7) GROUP BY doc_slug ORDER BY pv DESC LIMIT 10` |
| Agent 创建入口分布 | `SELECT entry, COUNT(*) AS cnt FROM events WHERE event_code = 'agent_create_success' AND dt >= DATE_SUB(TODAY(), 7) GROUP BY entry` |

**dt 是小时级分区字段，格式 `yyyyMMddHH`（如 `2026070210` = 2026年7月2日10时），注意年是要写4位，月是2位，日是2位、时是2位**
