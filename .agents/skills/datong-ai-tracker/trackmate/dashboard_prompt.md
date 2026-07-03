# datong-report 数据看板生成指令

> **使用说明**：将本文件内容复制到大同平台的「智能用数」中，平台会自动解析并创建看板。

---

这个知识库里包含大同平台的埋点明细数据。请基于明细数据和以下信息，在**一个看板**中生成所有图卡，按模块分组展示。（这些埋点才刚实现，线上可能还没有正式上报数据，所以查询无数据属于正常现象。）
======
## 一、埋点方案

### 约定说明
- **事件（event_code）** 是 Beacon 上报事件名，英文小写+下划线命名。
- **Skill 通过 Beacon 协议上报**，事件数据在 `mapValue` 中，字段均为自定义 key-value。
- 公共字段（每个事件自动携带）：`skill_name`（Skill 名称，固定为 `datong-report`）、`skill_user`（用户标识，whoami 自动采集，人维度 UV）、`skill_platform`（运行平台）、`skill_os`（操作系统）、`skill_version`（Skill 版本号，可选）。
- 设备标识 `A2` 用于设备维度 UV 去重（Beacon 协议层字段）；`skill_user` 用于人维度 UV 去重（通过 whoami 命令自动采集系统用户名）。
- **UV 统计优先使用 `skill_user`（人维度），降级使用 `A2`（设备维度）**。
- 触发时机说明：`session_start` = 会话开始，`session_end` = 会话关闭，`on_event` = 业务节点触发，`on_error` = 异常捕获。
---

### 1. 通用基础事件

| 触发时机 | 事件 event_code | 私有参数 |
|---------|----------------|---------|
| session_start | Skill调用 / `skill_invoked` | 会话ID / `session_id`；调用来源 / `source`；意图分类 / `intent_category`（可选，由模型根据用户意图自动归类） |
| on_event | 任务完成 / `task_completed` | 会话ID / `session_id`；完成状态 / `status`（值域：success/fail）；失败归因 / `fail_reason`（可选，值域：skill_bug/llm_limitation/user_cancel/dependency_error/timeout）；用户反馈 / `feedback`（可选，值域：positive/negative/retry/abandon） |
| on_error | 异常发生 / `error_occurred` | 错误类型 / `error_type`（值域：runtime/timeout/dependency/user_cancel）；错误摘要 / `error_message`；发生阶段 / `phase`；错误码 / `error_code`（可选，开发者自定义） |
| session_end | 会话结束 / `session_end` | 会话ID / `session_id`；会话时长秒 / `duration_seconds`；结束原因 / `reason`；对话轮数 / `turn_count`（可选） |

### 2. 业务私有事件

| 触发时机 | 事件 event_code | 私有参数 |
|---------|----------------|---------|
| on_event | 用户意图识别 / `intent_identified` | 意图类型 / `intent_type`（值域：dashboard/tracking/debug/multi/unrelated） |
| on_event | MCP 环境检查 / `mcp_check_result` | 状态 / `mcp_status`（值域：ready/blocked）；阻断原因 / `block_reason`（值域：mcporter_missing/auth_failed/service_down/other，仅 blocked 时填） |
| on_event | SDK 检测完成 / `sdk_detected` | 是否命中 / `sdk_hit`（值域：true/false）；SDK 类型 / `sdk_kind`（值域：beacon-h5/beacon-android/beacon-ios/videoreport-android/videoreport-ios/universal-report/autotracker/none）；技术栈 / `tech_stack`（值域：react/vue/nodejs/android/ios/flutter/miniprogram/other） |
| on_event | 用户路径选择 / `path_selected` | 路径类型 / `path_type`（值域：A/B/auto_by_param） |
| on_event | AppKey 注册结果 / `appkey_register_result` | 注册状态 / `register_status`（值域：success/fail/placeholder/skipped）；来源 / `appkey_source`（值域：detected/user_provided/registered/none）；路径类型 / `path_type`（值域：A/B）；失败原因 / `fail_reason`（可选，值域：name_conflict/network/auth/user_skip/other）；重试次数 / `retry_count`（值域：0/1/2/3） |
| on_event | 埋点信息拉取 / `tracking_info_fetched` | 参数形态 / `param_type`（值域：code/page_id/url/flow_id）；拉取结果 / `fetch_status`（值域：success/fail）；调用策略 / `fetch_strategy`（值域：single/batch_pages） |
| on_event | 上报代码生成 / `code_generated` | 路径类型 / `path_type`（值域：A/B）；事件数桶位 / `event_count`（值域：0/1-3/4-10/10+）；代码风格 / `output_kind`（值域：declarative/imperative/mixed） |
| on_event | 埋点方案上传 / `tracking_plan_uploaded` | 结果 / `upload_result`（值域：success/fail/skipped）；跳过原因 / `skip_reason`（可选，值域：no_appid/placeholder/user_skip）；重试次数 / `retry_count`（值域：0/1/2） |
| on_event | 看板 Prompt 生成 / `dashboard_prompt_generated` | 入口 / `entry`（值域：post_codegen/dashboard_flow）；状态 / `prompt_status`（值域：generated/skipped）；跳过原因 / `skip_reason`（可选，值域：upload_failed/no_appid/other）；看板数 / `dashboard_count`（值域：1/2/3+） |
| on_event | 联调进入 / `debug_session_started` | 入口 / `entry`（值域：post_codegen/standalone）；是否拿到 debugId / `debug_id_obtained`（值域：true/false）；SDK 类型 / `sdk_kind`（值域：beacon/universal_report/none） |

---

## 二、看板方案

> 以下所有图卡在**同一个看板**中，按三个模块分组展示。

### 模块一：Skill 总览（给老板汇报）

```
┌─────────────────────┬─────────────────────┬─────────────────────┬─────────────────────┐
│ 📈 今日调用量 (PV)    │ 📈 今日用户数 (UV)    │ 📈 任务成功率         │ 📈 本周活跃用户 (WAU) │
│                     │                     │                     │                     │
│ 今日 skill_invoked  │ 今日去重用户数        │ success / 总完成数    │ 近7天去重用户数       │
│ 总次数              │                     │                     │                     │
├─────────────────────┴─────────────────────┴─────────────────────┴─────────────────────┤
│                                                                                       │
│  📉 DAU 趋势（最近30天折线图）                                                           │
│                                                                                       │
├───────────────────────────────────┬───────────────────────────────────────────────────┤
│ 🥧 平台分布                       │ 📊 每日 PV/UV 对比（最近7天柱状图）                   │
│ (CodeBuddy vs OpenClaw vs BoxAI)  │                                                   │
└───────────────────────────────────┴───────────────────────────────────────────────────┘
```

**图卡计算逻辑：**
| 图卡 | 计算逻辑 (伪SQL) |
|------|-----------------|
| 今日调用量 (PV) | `SELECT COUNT(*) FROM events WHERE event_code = 'skill_invoked' AND ds >= CONCAT(TODAY(), '00') AND ds <= CONCAT(TODAY(), '23')` |
| 今日用户数 (UV) | `SELECT COUNT(DISTINCT COALESCE(skill_user, A2)) FROM events WHERE event_code = 'skill_invoked' AND ds >= CONCAT(TODAY(), '00') AND ds <= CONCAT(TODAY(), '23')` |
| 任务成功率 | `SELECT ROUND(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) AS success_rate FROM events WHERE event_code = 'task_completed' AND ds >= CONCAT(TODAY(), '00') AND ds <= CONCAT(TODAY(), '23')` |
| 本周活跃用户 (WAU) | `SELECT COUNT(DISTINCT COALESCE(skill_user, A2)) FROM events WHERE event_code = 'skill_invoked' AND ds >= CONCAT(DATE_SUB(TODAY(), 7), '00') AND ds <= CONCAT(TODAY(), '23')` |
| DAU 趋势 | `SELECT SUBSTR(ds, 1, 8) AS dt, COUNT(DISTINCT COALESCE(skill_user, A2)) AS dau FROM events WHERE event_code = 'skill_invoked' AND ds >= CONCAT(DATE_SUB(TODAY(), 30), '00') AND ds <= CONCAT(TODAY(), '23') GROUP BY SUBSTR(ds, 1, 8) ORDER BY dt DESC LIMIT 30` |
| 平台分布 | `SELECT skill_platform, COUNT(DISTINCT COALESCE(skill_user, A2)) AS users FROM events WHERE event_code = 'skill_invoked' AND ds >= CONCAT(DATE_SUB(TODAY(), 7), '00') AND ds <= CONCAT(TODAY(), '23') GROUP BY skill_platform` |
| 每日 PV/UV 对比 | `SELECT SUBSTR(ds, 1, 8) AS dt, COUNT(*) AS pv, COUNT(DISTINCT COALESCE(skill_user, A2)) AS uv FROM events WHERE event_code = 'skill_invoked' AND ds >= CONCAT(DATE_SUB(TODAY(), 7), '00') AND ds <= CONCAT(TODAY(), '23') GROUP BY SUBSTR(ds, 1, 8) ORDER BY dt` |

---

### 模块二：Skill 监控（给开发者）

```
┌─────────────────────┬─────────────────────┬─────────────────────┬─────────────────────┐
│ 📈 今日异常数         │ 📈 异常率            │ 📈 平均会话时长       │ 📈 今日失败任务数     │
│                     │                     │                     │                     │
│ 今日 error_occurred │ 异常数 / 调用数       │ AVG(duration)       │ status=fail 数       │
│ 总次数              │                     │                     │                     │
├─────────────────────┴─────────────────────┴─────────────────────┴─────────────────────┤
│                                                                                       │
│  📉 异常率趋势（最近14天折线图）                                                          │
│                                                                                       │
├───────────────────────────────────┬───────────────────────────────────────────────────┤
│ 🥧 错误类型分布                    │ 📊 任务完成状态分布（最近7天堆叠柱状图）               │
├───────────────────────────────────┴───────────────────────────────────────────────────┤
│                                                                                       │
│  📊 会话时长分布（柱状图，按 <30s / 30s-2m / 2m-5m / 5m-10m / >10m 分桶）               │
│                                                                                       │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

**图卡计算逻辑：**
| 图卡 | 计算逻辑 (伪SQL) |
|------|-----------------|
| 今日异常数 | `SELECT COUNT(*) FROM events WHERE event_code = 'error_occurred' AND ds >= CONCAT(TODAY(), '00') AND ds <= CONCAT(TODAY(), '23')` |
| 异常率 | `SELECT ROUND(err.cnt * 100.0 / inv.cnt, 2) AS error_rate FROM (SELECT COUNT(*) AS cnt FROM events WHERE event_code = 'error_occurred' AND ds >= CONCAT(TODAY(), '00') AND ds <= CONCAT(TODAY(), '23')) err, (SELECT COUNT(*) AS cnt FROM events WHERE event_code = 'skill_invoked' AND ds >= CONCAT(TODAY(), '00') AND ds <= CONCAT(TODAY(), '23')) inv` |
| 平均会话时长 | `SELECT AVG(CAST(duration_seconds AS BIGINT)) FROM events WHERE event_code = 'session_end' AND ds >= CONCAT(TODAY(), '00') AND ds <= CONCAT(TODAY(), '23')` |
| 今日失败任务数 | `SELECT COUNT(*) FROM events WHERE event_code = 'task_completed' AND status = 'fail' AND ds >= CONCAT(TODAY(), '00') AND ds <= CONCAT(TODAY(), '23')` |
| 异常率趋势 | `SELECT SUBSTR(ds, 1, 8) AS dt, ROUND(SUM(CASE WHEN event_code = 'error_occurred' THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN event_code = 'skill_invoked' THEN 1 ELSE 0 END), 0), 2) AS error_rate FROM events WHERE event_code IN ('error_occurred', 'skill_invoked') AND ds >= CONCAT(DATE_SUB(TODAY(), 14), '00') AND ds <= CONCAT(TODAY(), '23') GROUP BY SUBSTR(ds, 1, 8) ORDER BY dt DESC LIMIT 14` |
| 错误类型分布 | `SELECT error_type, COUNT(*) AS cnt FROM events WHERE event_code = 'error_occurred' AND ds >= CONCAT(DATE_SUB(TODAY(), 7), '00') AND ds <= CONCAT(TODAY(), '23') GROUP BY error_type ORDER BY cnt DESC` |
| 任务完成状态分布 | `SELECT SUBSTR(ds, 1, 8) AS dt, status, COUNT(*) AS cnt FROM events WHERE event_code = 'task_completed' AND ds >= CONCAT(DATE_SUB(TODAY(), 7), '00') AND ds <= CONCAT(TODAY(), '23') GROUP BY SUBSTR(ds, 1, 8), status ORDER BY dt` |
| 会话时长分布 | `SELECT CASE WHEN CAST(duration_seconds AS BIGINT) < 30 THEN '<30s' WHEN CAST(duration_seconds AS BIGINT) < 120 THEN '30s-2m' WHEN CAST(duration_seconds AS BIGINT) < 300 THEN '2m-5m' WHEN CAST(duration_seconds AS BIGINT) < 600 THEN '5m-10m' ELSE '>10m' END AS duration_bucket, COUNT(*) AS cnt FROM events WHERE event_code = 'session_end' AND ds >= CONCAT(DATE_SUB(TODAY(), 7), '00') AND ds <= CONCAT(TODAY(), '23') GROUP BY duration_bucket ORDER BY cnt DESC` |

---

### 模块三：业务分析（datong-report 专属）

```
┌─────────────────────┬─────────────────────┬─────────────────────┬─────────────────────┐
│ 📈 意图分布          │ 📈 MCP 阻断率        │ 📈 应用注册成功率     │ 📈 看板创建转化率     │
│                     │                     │                     │                     │
│ tracking/dashboard/ │ blocked / 总检查数    │ success / 总注册数    │ dashboard_prompt /   │
│ debug 占比          │                     │                     │ tracking_plan_upload │
├─────────────────────┴─────────────────────┴─────────────────────┴─────────────────────┤
│                                                                                       │
│  📉 接入主流程漏斗（sdk_detected → path_selected → code_generated → tracking_plan_uploaded.success）│
│                                                                                       │
├───────────────────────────────────┬───────────────────────────────────────────────────┤
│ 🥧 接入路径分布 (A/B/auto)         │ 📊 SDK 类型分布（最近 7 天柱状图）                   │
├───────────────────────────────────┼───────────────────────────────────────────────────┤
│ 🥧 MCP 阻断原因分布                │ 📊 联调入口分布 (post_codegen vs standalone)         │
└───────────────────────────────────┴───────────────────────────────────────────────────┘
```

**图卡计算逻辑：**
| 图卡 | 计算逻辑 (伪SQL) |
|------|-----------------|
| 意图分布 | `SELECT intent_type, COUNT(*) AS cnt FROM events WHERE event_code = 'intent_identified' AND ds >= CONCAT(DATE_SUB(TODAY(), 7), '00') AND ds <= CONCAT(TODAY(), '23') GROUP BY intent_type ORDER BY cnt DESC` |
| MCP 阻断率 | `SELECT ROUND(SUM(CASE WHEN mcp_status = 'blocked' THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) AS block_rate FROM events WHERE event_code = 'mcp_check_result' AND ds >= CONCAT(DATE_SUB(TODAY(), 7), '00') AND ds <= CONCAT(TODAY(), '23')` |
| 应用注册成功率 | `SELECT ROUND(SUM(CASE WHEN register_status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) AS success_rate FROM events WHERE event_code = 'appkey_register_result' AND ds >= CONCAT(DATE_SUB(TODAY(), 7), '00') AND ds <= CONCAT(TODAY(), '23')` |
| 看板创建转化率 | `SELECT ROUND(d.cnt * 100.0 / NULLIF(u.cnt, 0), 2) AS conv_rate FROM (SELECT COUNT(*) AS cnt FROM events WHERE event_code = 'dashboard_prompt_generated' AND prompt_status = 'generated' AND ds >= CONCAT(DATE_SUB(TODAY(), 7), '00') AND ds <= CONCAT(TODAY(), '23')) d, (SELECT COUNT(*) AS cnt FROM events WHERE event_code = 'tracking_plan_uploaded' AND upload_result = 'success' AND ds >= CONCAT(DATE_SUB(TODAY(), 7), '00') AND ds <= CONCAT(TODAY(), '23')) u` |
| 接入主流程漏斗 | `SELECT event_code, COUNT(*) AS step_cnt FROM events WHERE event_code IN ('sdk_detected', 'path_selected', 'code_generated', 'tracking_plan_uploaded') AND ds >= CONCAT(DATE_SUB(TODAY(), 7), '00') AND ds <= CONCAT(TODAY(), '23') GROUP BY event_code ORDER BY CASE event_code WHEN 'sdk_detected' THEN 1 WHEN 'path_selected' THEN 2 WHEN 'code_generated' THEN 3 WHEN 'tracking_plan_uploaded' THEN 4 END` |
| 接入路径分布 | `SELECT path_type, COUNT(*) AS cnt FROM events WHERE event_code = 'path_selected' AND ds >= CONCAT(DATE_SUB(TODAY(), 7), '00') AND ds <= CONCAT(TODAY(), '23') GROUP BY path_type ORDER BY cnt DESC` |
| SDK 类型分布 | `SELECT sdk_kind, COUNT(*) AS cnt FROM events WHERE event_code = 'sdk_detected' AND ds >= CONCAT(DATE_SUB(TODAY(), 7), '00') AND ds <= CONCAT(TODAY(), '23') GROUP BY sdk_kind ORDER BY cnt DESC` |
| MCP 阻断原因分布 | `SELECT block_reason, COUNT(*) AS cnt FROM events WHERE event_code = 'mcp_check_result' AND mcp_status = 'blocked' AND ds >= CONCAT(DATE_SUB(TODAY(), 7), '00') AND ds <= CONCAT(TODAY(), '23') GROUP BY block_reason ORDER BY cnt DESC` |
| 联调入口分布 | `SELECT entry, COUNT(*) AS cnt FROM events WHERE event_code = 'debug_session_started' AND ds >= CONCAT(DATE_SUB(TODAY(), 7), '00') AND ds <= CONCAT(TODAY(), '23') GROUP BY entry ORDER BY cnt DESC` |
