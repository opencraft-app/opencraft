# LightVela 大同埋点事件对照表

> 数据源：`frontend/src/observability/datong.ts`（单一事实源）
> 事件总量：**32 个 = 5 个 SDK 默认 + 27 个业务自定义**
> 上报链路：`@tencent/universal-report` → 大同平台 → StarRocks
> 数据库主键组合：`event_code + dt_pgid + dt_eid`；`ref_from` 存来源渠道
> ★ = 近期报表中有上报数据

## 事件总表

| # | 事件名 | 类别 | 中文名 | 触发时机 / 业务含义 | 报表 |
|---|---|---|---|---|---|
| 1 | `dt_pgin` | SDK 默认 | 进入页面 | 页面挂载/路由切换，自动上报；PV 与来源曝光 | ★ |
| 2 | `dt_pgout` | SDK 默认 | 离开页面 | 页面卸载/路由离开，自动上报；平均停留时长 | ★ |
| 3 | `dt_clck` | SDK 默认 | 元素点击 | 任意点击自动上报（注意拼写 `clck` 无 i）；点击密度、CTA 热区 | ★ |
| 4 | `dt_imp` | SDK 默认 | 元素曝光 | 元素进入视口，自动上报 | |
| 5 | `dt_imp_end` | SDK 默认 | 元素曝光结束 | 元素离开视口，与 `dt_imp` 配对计算元素停留 | |
| 6 | `login_attempt` | 登录认证 | 发起登录 | 登录漏斗入口 | |
| 7 | `login_success` | 登录认证 | 登录成功 | 注册转化主指标 | |
| 8 | `login_fail` | 登录认证 | 登录失败 | 失败率告警 | |
| 9 | `subscribe_checkout_start` | 订阅漏斗 | 进入订阅结算页 | 付费意向，转化漏斗入口 | ★ |
| 10 | `subscribe_pay_success` | 订阅漏斗 | 支付成功 | **收入事件**，转化漏斗终点 | ★ |
| 11 | `subscribe_pay_fail` | 订阅漏斗 | 支付失败 | 支付链路排障 | |
| 12 | `agent_create_success` | Agent 创建 | Agent 创建成功 | 激活转化（访客→用户） | ★ |
| 13 | `agent_create_fail` | Agent 创建 | Agent 创建失败 | 创建链路告警 | |
| 14 | `channel_connect_success` | 渠道接入 | 通道绑定成功 | 微信/钉钉/Telegram 等通道接入 | |
| 15 | `model_switch` | 模型配置 | 切换模型 | 模型偏好分析 | |
| 16 | `model_provider_select` | 模型配置 | 选择模型供应商 | 供应商分布 | |
| 17 | `model_api_key_add` | 模型配置 | 添加 API Key | 自带 key 用户占比 | |
| 18 | `model_custom_add` | 模型配置 | 添加自定义模型 | 高阶用户行为 | |
| 19 | `skill_search` | 技能 | 搜索技能 | 技能需求分析 | |
| 20 | `skill_install_success` | 技能 | 安装技能成功 | 技能渗透率 | |
| 21 | `skill_pack_install_success` | 技能 | 安装技能包成功 | 技能包渗透率 | |
| 22 | `persona_inject_success` | 人设注入 | 人设注入成功 | 注入链路健康度 | ★ |
| 23 | `persona_inject_fail` | 人设注入 | 人设注入失败 | 失败率告警（与 22 配对） | ★ |
| 24 | `automation_create_success` | 自动化 | 自动任务创建成功 | 自动化功能渗透率 | ★ |
| 25 | `automation_delete` | 自动化 | 自动任务删除 | 与 24 配对看留存/流失 | ★ |
| 26 | `memory_quota_update` | 记忆 | 记忆配额更新 | 配额策略效果追踪 | ★ |
| 27 | `diagnostics_action` | 诊断 | 诊断操作 | 诊断中心使用情况 | |
| 28 | `agent_message_send` | 对话/北极星 | 发送对话消息 | **活跃度核心指标**（DAU/MAU 代理） | ★ |
| 29 | `agent_message_fail` | 对话/北极星 | 消息发送失败 | 对话链路告警 | |
| 30 | `doc_search` | 文档搜索 | 文档搜索 | 文档可用性 | |
| 31 | `doc_search_result_click` | 文档搜索 | 点击搜索结果 | 与 30 配对算搜索命中率 | |
| 32 | `landing_referral` | 来源追踪 | 着陆页来源 | 渠道 ROI（discord/twitter/kol），SDK 初始化后立即上报 | ★ |

## 核心漏斗口径

```
获客   landing_referral ──→ dt_pgin（PV）
激活   agent_create_success ──→ agent_message_send（留存/活跃）
变现   subscribe_checkout_start ──→ subscribe_pay_success（转化率 = #10 / #9）
```

## 注意事项

1. **报表只显示有数据的事件**：报表通常只展示部分事件（近期约 14 个），其余自定义事件触发场景少或仅特定站点/页面启用，不代表未定义
2. **代码注释过时**：`datong.ts` 中 `reportDatongEvent` 的注释写"30 个业务事件"，实际常量为 27 个，以代码为准
3. **另一条埋点链路勿混淆**：`posthog.ts` 另有 7 个产品分析事件（`landing_cta_clicked` / `login_modal_opened` / `oauth_provider_clicked` / `subscribe_cta_clicked` / `agent_create_started/succeeded/failed`），走 PostHog 而非大同，不进本报表
4. **新增事件规范**：沿用 `类别前缀_动作_结果`（snake_case）命名，扩展 `DATONG_EVENTS` 常量表，不要散落字符串；`dt_pgid` 页面值需同步登记到 `DATONG_PAGE_IDS`
