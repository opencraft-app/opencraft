# 通用产品增长场景

## 1. 场景定义

适用于大多数 Web / App / 小程序 / 工具型产品。当仓库里能看到“注册、激活、活跃、留存、关键功能使用、转化”主线，但还不能明确归入电商、SaaS、游戏、教育等垂直行业时，优先使用本场景。

## 2. 仓库命中信号

- 用户体系：`user`、`member`、`account`、`profile`
- 基础行为：`signup`、`login`、`session_start`、`page_view`
- 激活动作：`create_project`、`complete_profile`、`upload_file`、`first_success`
- 功能使用：`feature_used`、`search`、`save`、`share`、`publish`

## 3. North Star 候选

优先候选：**每周完成关键价值动作的活跃用户数**；备选：每周激活用户数、人均关键价值动作次数。

## 4. 默认优先推荐指标（含口径与埋点）

### 4.1 核心结果指标

| 指标 | 类型 | 何时推荐 | 建议口径 | 需要的埋点 / 数据 | 关键属性 / 常见切片 |
|---|---|---|---|---|---|
| 新增用户数 | 核心结果 | 存在注册或首次识别逻辑 | 统计周期内首次完成 `sign_up_success` 的去重用户数；若无注册，则用 `first_visit` 去重用户数 | `sign_up_success` / `first_visit` | `user_id` / `anonymous_id`、`channel`、`device`、`app_version` |
| 激活率 | 核心结果 | 能明确首个价值动作 | 注册后 24h / 7d 内完成 `activation_event` 的用户数 ÷ 同期新增用户数 | `sign_up_success` + `activation_event` | 需固定“首个价值动作” |
| DAU / WAU / MAU | 核心结果 | 产品有连续使用属性 | 统计窗口内发生活跃定义事件的去重用户数 | `session_start` / `page_view` / `core_action` | 先固定活跃口径 |
| 关键动作用户数 | 核心结果 | 核心价值动作明确 | 统计窗口内发生 `core_action` 的去重用户数 | `core_action` | `feature_name` / `module` |
| 人均关键动作次数 | 核心结果 | 价值体现在频次或深度 | `core_action` 总次数 ÷ 活跃用户数 | `core_action` + 活跃口径事件 | 可按分群、版本、渠道切片 |
| 留存率（D1/D7/W4） | 核心结果 | 有稳定用户身份和 cohort 起点 | 第 0 天新增用户中，在第 1 / 7 / 28 天再次活跃的去重用户数 ÷ 第 0 天新增用户数 | `sign_up_success` / `first_visit` + 活跃事件 | 必须固定 cohort 起点 |
| 付费转化率 | 核心结果 | 存在付费链路 | 完成 `purchase_success` 的去重用户数 ÷ 激活用户数（或新增用户数，需固定） | `purchase_success` + 激活口径事件 | 不要同时混用两个分母 |

### 4.2 诊断 / 护栏指标

| 指标 | 类型 | 何时推荐 | 建议口径 | 需要的埋点 / 数据 | 关键属性 / 常见切片 |
|---|---|---|---|---|---|
| 注册漏斗转化率 | 诊断 | 注册有多步流程 | 各步骤完成用户数 ÷ 上一步完成用户数 | `register_step_view` / `register_step_submit` / `sign_up_success` | `step_id`、失败原因、设备、渠道 |
| 首次价值达成时间（TTV） | 诊断 | onboarding 很关键 | 从注册成功到首次 `activation_event` 的中位数 / P75 耗时 | `sign_up_success` + `activation_event` | 建议展示 median + P75 |
| 关键功能采用率 | 诊断 | 产品有多模块功能 | 使用某功能的去重用户数 ÷ 活跃用户数 | `feature_used` + 活跃口径事件 | `feature_name`、`module` |
| 会话频次 / 周活跃天数 | 诊断 | 需要观察使用粘性 | 人均 session 数；或每用户活跃天数分布 | `session_start` | 适合看分位数 |
| 页面跳出率 | 诊断 | Web / 内容浏览链路明显 | 仅访问 1 页且无 engagement 的 session 数 ÷ 总 session 数 | `session_start` + `page_view` + `engaged_event` | Web 更适用 |
| 错误率 / 崩溃率 | 护栏 | 产品质量影响使用 | `error_event` 次数 ÷ session 数；或 crash 用户数 ÷ 活跃用户数 | `error_event` / `app_crash` + `session_start` | 按版本、机型、接口拆分 |

## 5. 不要乱推

- 没有稳定 `user_id` 时，不要硬推跨天留存和复购。
- 没有明确价值动作时，不要用 DAU 代替全部业务目标。
- 没有付费链路时，不要提前引入 LTV、ARPU、付费转化。
