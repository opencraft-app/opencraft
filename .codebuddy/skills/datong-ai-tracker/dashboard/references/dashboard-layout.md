# 看板布局规范和组件说明

> 本文档在 Step 5 中使用，定义看板的布局和组件规范。

---

## 看板布局结构

一个标准看板由上到下分为三个区域：

```
┌──────────────────────────────────────────────┐
│                 顶部：指标卡片区                │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐      │
│  │ PV   │  │ UV   │  │ 停留  │  │ 点击率│      │
│  │12,345│  │8,901 │  │2m30s │  │23.4% │      │
│  └──────┘  └──────┘  └──────┘  └──────┘      │
├──────────────────────────────────────────────┤
│                 中部：趋势图表区                │
│  ┌─────────────────────┐  ┌────────────────┐  │
│  │  折线图/面积图        │  │  柱状图/饼图    │  │
│  │  （时间趋势）         │  │  （分布对比）    │  │
│  └─────────────────────┘  └────────────────┘  │
├──────────────────────────────────────────────┤
│                 底部：明细表格区                │
│  ┌──────────────────────────────────────────┐ │
│  │  排名 | 页面/元素 | PV | UV | 点击率 | ... │ │
│  │  1    | 首页      | .. | .. | ..     |     │ │
│  └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

---

## 事件名称规范

所有组件配置中的事件名称必须使用大同标准名称：

| 事件名 | 含义 |
|--------|------|
| `dt_pgin` | 页面曝光 |
| `dt_pgout` | 页面结束曝光，参数 `dt_lvtm` 为停留时长 |
| `dt_imp` | 元素曝光 |
| `dt_imp_end` | 元素结束曝光 |
| `dt_clck` | 元素点击 |

---

## 组件类型

### 1. 指标卡片（MetricCard）

用于展示单个数值型指标，适合核心 KPI。

```json
{
  "type": "metric_card",
  "title": "页面 PV",
  "metric": {
    "event": "dt_pgin",
    "aggregation": "count"
  },
  "compare": "day_over_day",
  "format": "number"
}
```

| 字段 | 说明 | 可选值 |
|------|------|-------|
| aggregation | 聚合方式 | `count`, `count_distinct`, `sum`, `avg` |
| compare | 对比方式 | `day_over_day`(日环比), `week_over_week`(周同比), `none` |
| format | 显示格式 | `number`, `percent`, `duration` |

### 2. 趋势图（TrendChart）

用于展示指标随时间的变化趋势。

```json
{
  "type": "trend_chart",
  "title": "PV/UV 趋势",
  "chart_type": "line",
  "metrics": [
    {"name": "PV", "event": "dt_pgin", "aggregation": "count"},
    {"name": "UV", "event": "dt_pgin", "aggregation": "count_distinct", "field": "user_id"}
  ],
  "time_range": "last_7_days",
  "granularity": "day"
}
```

| 字段 | 说明 | 可选值 |
|------|------|-------|
| chart_type | 图表类型 | `line`(折线), `area`(面积), `bar`(柱状) |
| time_range | 时间范围 | `last_7_days`, `last_30_days`, `last_90_days`, `custom` |
| granularity | 时间粒度 | `hour`, `day`, `week`, `month` |

### 3. 分布图（DistributionChart）

用于展示指标在不同维度上的分布。

```json
{
  "type": "distribution_chart",
  "title": "各页面访问量分布",
  "chart_type": "pie",
  "metric": {
    "event": "dt_pgin",
    "aggregation": "count"
  },
  "dimension": "dt_pgid",
  "top_n": 10
}
```

| 字段 | 说明 | 可选值 |
|------|------|-------|
| chart_type | 图表类型 | `pie`(饼图), `bar`(横向柱状), `treemap`(矩形树图) |
| dimension | 分布维度 | 事件参数字段名 |
| top_n | 取前 N 项 | 数字，其余归为"其他" |

### 4. 漏斗图（FunnelChart）

用于展示转化漏斗。

```json
{
  "type": "funnel_chart",
  "title": "核心转化漏斗",
  "steps": [
    {"name": "访问页面", "event": "dt_pgin", "filter": {"dt_pgid": "target_page"}},
    {"name": "点击关键按钮", "event": "dt_clck", "filter": {"dt_eid": "key_button"}},
    {"name": "完成操作", "event": "custom_complete"}
  ]
}
```

### 5. 明细表格（DetailTable）

用于展示按维度聚合的详细数据。

```json
{
  "type": "detail_table",
  "title": "页面数据明细",
  "dimensions": ["dt_pgid"],
  "metrics": [
    {"name": "PV", "event": "dt_pgin", "aggregation": "count"},
    {"name": "UV", "event": "dt_pgin", "aggregation": "count_distinct", "field": "user_id"},
    {"name": "平均停留时长", "event": "dt_pgout", "aggregation": "avg", "field": "dt_lvtm"}
  ],
  "sort_by": "PV",
  "sort_order": "desc",
  "page_size": 20
}
```

---

## 看板配置完整示例

```json
{
  "dashboard_name": "项目数据看板",
  "description": "监控核心页面的流量和互动指标",
  "time_range": "last_7_days",
  "auto_refresh": 300,
  "layout": {
    "cards": [
      {"type": "metric_card", "title": "页面 PV", "metric": {"event": "dt_pgin", "aggregation": "count"}, "compare": "day_over_day", "format": "number"},
      {"type": "metric_card", "title": "页面 UV", "metric": {"event": "dt_pgin", "aggregation": "count_distinct", "field": "user_id"}, "compare": "day_over_day", "format": "number"},
      {"type": "metric_card", "title": "平均停留时长", "metric": {"event": "dt_pgout", "aggregation": "avg", "field": "dt_lvtm"}, "compare": "day_over_day", "format": "duration"},
      {"type": "metric_card", "title": "元素点击率", "metric": {"numerator": {"event": "dt_clck", "aggregation": "count"}, "denominator": {"event": "dt_imp", "aggregation": "count"}, "aggregation": "ratio"}, "compare": "day_over_day", "format": "percent"}
    ],
    "charts": [
      {"type": "trend_chart", "title": "PV/UV 趋势", "chart_type": "line", "metrics": [{"name": "PV", "event": "dt_pgin", "aggregation": "count"}, {"name": "UV", "event": "dt_pgin", "aggregation": "count_distinct", "field": "user_id"}], "granularity": "day"},
      {"type": "distribution_chart", "title": "页面访问分布 TOP10", "chart_type": "bar", "metric": {"event": "dt_pgin", "aggregation": "count"}, "dimension": "dt_pgid", "top_n": 10}
    ],
    "tables": [
      {"type": "detail_table", "title": "页面数据明细", "dimensions": ["dt_pgid"], "metrics": [{"name": "PV", "event": "dt_pgin", "aggregation": "count"}, {"name": "UV", "event": "dt_pgin", "aggregation": "count_distinct", "field": "user_id"}, {"name": "平均停留时长", "event": "dt_pgout", "aggregation": "avg", "field": "dt_lvtm"}], "sort_by": "PV", "sort_order": "desc"}
    ]
  }
}
```

---

## 布局规则

1. **指标卡片区**：放置 3-6 个核心指标卡片，一行排列
2. **趋势图表区**：1-2 个图表并列，左侧通常是时间趋势，右侧是分布/对比
3. **明细表格区**：1 个表格，支持分页和排序
4. **组件数量**：一个看板总组件数建议不超过 10 个，避免信息过载
