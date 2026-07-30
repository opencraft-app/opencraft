# 看板 Prompt 生成规范
## Prompt 整体结构：

```
引导语
======
## 一、埋点方案
  约定说明
  事件表格（按模块/页面分组）

## 二、看板方案
  看板 1：{看板名}
    ASCII 布局图
    图卡计算逻辑（伪 SQL 表格）
  看板 2：{看板名}（可选，多看板时）
    ...
```

## 引导语（固定）

每个 Prompt 必须以这段引导语开头：

```
这个知识库里包含{产品名称}的埋点明细数据。请基于明细数据和以下信息，生成看板图卡。（这些埋点才刚实现，线上可能还没有正式上报数据，所以查询无数据属于正常现象。）
======
```

> `======` 是引导语和正文的分隔符，必须保留。
> `{产品名称}` 需根据当前项目上下文替换为实际的产品/平台名称（如用户项目名、应用名等）。

## Part 1：埋点方案

### 约定说明（固定结构）

在事件表格之前，需要先写一段约定说明，帮助看板平台理解表格字段的含义：

```markdown
## 一、埋点方案
### 约定说明
- **事件（event_code）** 是上报事件名，英文命名，表中 `中文 / english` 对照。
- **页面（dt_pgid）** 标识所在页面。
- **元素（dt_eid）** 标识交互元素。
- **私有参数（udf_kv）** 为事件携带的上下文参数，多个参数用分号分隔，格式为 `中文名 / 字段名`。udf_kv 是导入和管理层面的概念，分析时使用其下的具体 key 名。
- 触发时机列说明含义：`pv` = 页面可见，`click` = 点击，`change` = 切换/变更，`submit` = 表单提交，`expose` = 曝光。
```

### 事件表格格式

按**模块/页面**分组，每组一个表格。**与埋点方案表格统一使用 7 列格式**，不再使用 ext1–ext5 展开列：

```markdown
### {模块编号}. {模块名称}
| 触发时机 | 示意图 | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|---------|:----:|----------------|-------------|:----------:|----------------------|-------|
| {时机} | — | {中文名} / `{英文名}` | {中文} / `{标识}` | {中文} / `{标识}` | `{字段名}` {中文名}；`{字段名}` {中文名} | {补充说明或 —} |
```

### 字段规范

| 字段 | 说明 | 格式要求 |
|------|------|---------|
| **触发时机** | 事件何时触发 | `pv`、`pv（路由进入）`、`pv（路由离开）`、`click`、`submit`、`change`、`expose` |
| **示意图** | 事件触发位置的界面示意 | 占位符 `—`（后续可替换为截图链接或文字描述） |
| **事件 event_code** | 事件名称 | 格式：`中文名 / 英文标识`，如 `页面曝光 / dt_pgin` |
| **页面 dt_pgid** | 页面标识 | 格式：`中文名 / 标识`，如 `首页 / home`。动态页面用 `当前页面ID / {pageId}` |
| **元素 dt_eid** | 元素标识 | 格式：`中文名 / 标识`，如 `搜索按钮 / search_btn`。无元素时填 `—` |
| **私有参数 udf_kv** | 事件携带的全部上下文参数 | 多个参数用分号 `;` 分隔，每个参数格式: `` `字段名` 中文名 ``。无参数时填 `—` |
| **说明 remark** | 对该条埋点事件的补充说明 | 自然语言描述，无需补充时填 `—` |

> ⚠️ **不再使用 ext1–ext5 列**。所有私有参数统一放在 `udf_kv` 一列中，与埋点方案表格格式完全一致。`udf_kv` 是导入和管理层面的概念标识，伪 SQL 中直接使用 `udf_kv` 下的具体 key 名（如 `article_id`、`category_name`）作为查询条件，不再出现 `ext1`–`ext5`，也不直接引用 `udf_kv` 字段本身。

### 事件命名与触发时机的对应关系

结合 SKILL.md 中的大同事件名称规范，在 Prompt 的埋点方案中：

| 大同标准事件 | 在 Prompt 中的 event_code 写法 | 触发时机 |
|------------|-------------------------------|---------|
| `dt_pgin` | 必须使用 `dt_pgin`，通过 `dt_pgid` 区分不同页面 | `pv（路由进入）` |
| `dt_pgout` | 必须使用 `dt_pgout`，私有参数中需含停留时长 | `pv（路由离开）` |
| `dt_imp` | 必须使用 `dt_imp`，通过 `dt_eid` 区分不同元素 | `expose` |
| `dt_imp_end` | 必须使用 `dt_imp_end`，通过 `dt_eid` 区分不同元素 | `expose（离开视口）` |
| `dt_clck` | 必须使用 `dt_clck`，通过 `dt_eid` 区分不同按钮/交互元素 | `click` |
| 自定义事件 | 业务自定义命名（如 `form_submit`、`create_app_submit`） | `submit`、`change` 等非标准行为 |

> ⚠️ 标准事件（`dt_pgin`、`dt_pgout`、`dt_clck`、`dt_imp`、`dt_imp_end`）**必须使用原始事件名**，不允许替换为业务自定义名称。通过 `dt_pgid`（页面标识）和 `dt_eid`（元素标识）来区分不同的业务场景。只有自定义事件才使用业务语义化命名。

---

## Part 2：看板方案

### 看板结构

每个看板包含两部分：

1. **ASCII 布局图** — 用字符画描述看板的视觉布局
2. **图卡计算逻辑表** — 用伪 SQL 描述每个图卡的数据计算方式

### ASCII 布局图规范

使用 `┌─┐│└─┘├┤┬┴┼` 等 box-drawing 字符绘制布局：

```
┌──────────┬──────────┬──────────┬──────────┐
│ 📈 指标卡1 │ 📈 指标卡2 │ 📈 指标卡3 │ 📈 指标卡4 │
│           │           │           │           │
│ 说明文字   │ 说明文字   │ 说明文字   │ 说明文字   │
├──────────┴──────────┴──────────┴──────────┤
│                                            │
│  📉 图表标题                                │
│  ┌────────────────────────────────────┐    │
│  │         图表示意                     │    │
│  └────────────────────────────────────┘    │
│                                            │
├─────────────────────┬──────────────────────┤
│ 🥧 图表标题          │ 📊 图表标题           │
│                     │                      │
└─────────────────────┴──────────────────────┘
```

**布局规则**：
- 顶行放核心 KPI 指标卡片（3-6 个）
- 中部放趋势图（折线图/面积图）
- 底部放分布图、表格或辅助图表
- 每个图卡前用 emoji 标识类型：📈 数值卡、📉 折线图、📊 柱状图、🥧 饼图、🔻 漏斗图

### 图卡计算逻辑表

紧跟在 ASCII 布局图之后，用表格列出每个图卡的伪 SQL：

```markdown
**图卡计算逻辑：**
| 图卡 | 计算逻辑 (伪SQL) |
|------|-----------------|
| {图卡名} | `{伪SQL}` |
```

### 伪 SQL 规范

> ⚠️ **核心变更：伪 SQL 中直接使用 `udf_kv` 下的具体 key 名（如 `article_id`、`category_name`），不再出现 `ext1`–`ext5`，也不直接引用 `udf_kv` 字段本身。** 具体 key 名必须与 Part 1 埋点方案表格中 `私有参数 udf_kv` 列里定义的字段名完全一致。

| 语法元素 | 说明 | 示例 |
|---------|------|------|
| `events` 表 | 埋点明细数据表 | `FROM events` |
| `event_code` | 事件名称字段 | `WHERE event_code = 'dt_pgin'` |
| `dt_pgid` | 页面标识字段 | `WHERE dt_pgid = 'home'` |
| `dt_eid` | 元素标识字段 | `WHERE dt_eid = 'search_btn'` |
| udf_kv 下的具体 key | 直接使用埋点方案中定义的字段名 | `WHERE article_id = 'xxx'`、`GROUP BY category_name` |
| `dt` | 小时级分区字段，格式 `yyyyMMddHH`（如 `2026051320` = 2026年5月13日20时），注意是10位数字（4位年+2位月+2位日+2位时），不是8位 | `WHERE dt >= TODAY()` |
| `TODAY()` | 当天（返回当天所有小时分区） | `dt >= TODAY()` |
| `DATE_SUB(TODAY(), N)` | 前 N 天 | `dt >= DATE_SUB(TODAY(), 7)` |

> ⚠️ `dt` 分区格式为 `yyyyMMddHH`（小时级粒度，10位数字：4位年+2位月+2位日+2位时），查询时 `TODAY()` 和 `DATE_SUB()` 会自动展开为对应的小时分区范围，伪 SQL 中直接使用即可，无需手动拼接分区值。
| `COUNT(*)` | 计数 | PV 等场景 |
| `COUNT(DISTINCT field)` | 去重计数 | UV 等场景 |
| `AVG(CAST(field AS BIGINT))` | 平均值（需转数值类型） | 停留时长等场景 |
| `GROUP BY` | 分组 | 趋势、分布等场景 |
| `ORDER BY ... LIMIT N` | 排序取 TopN | TOP10 等场景 |

**udf_kv 具体 key 使用规则**：
- 伪 SQL 中引用的字段名必须与 Part 1 埋点方案中 `udf_kv` 列的反引号内容完全一致
- 例如埋点表中写了 `` `category_name` 分类名称 ``，伪 SQL 就写 `GROUP BY category_name`
- 例如埋点表中写了 `` `duration` 停留时长ms ``，伪 SQL 就写 `AVG(CAST(duration AS BIGINT))`
- **严禁**在伪 SQL 中出现 `ext1`、`ext2` 等物理列名
- **严禁**在伪 SQL 中直接引用 `udf_kv` 字段本身（如 `udf_kv.category_name` 或 `WHERE udf_kv = 'xxx'`），必须直接使用具体 key 名


### dt 时区格式提醒（非常重要，严禁漏掉）
最后在图卡计算逻辑部分最后，都要加上一句：
**dt 是小时级分区字段，格式 `yyyyMMddHH`（如 `2026051320` = 2026年5月13日20时）, 注意年是要写4位， 月是2位， 日是2位、 时是2位**


---

## 完整示例

以下是一个**管理后台项目**的完整 Prompt 示例，展示了从埋点方案到看板方案的全部内容：

```markdown
这个知识库里包含大同平台的埋点明细数据。请基于明细数据和以下信息，生成看板图卡。（这些埋点才刚实现，线上可能还没有正式上报数据，所以查询无数据属于正常现象。）
======
## 一、埋点方案
### 约定说明
- **事件（event_code）** 是上报事件名，英文命名，表中 `中文 / english` 对照。
- **页面（dt_pgid）** 标识所在页面。
- **元素（dt_eid）** 标识交互元素。
- **私有参数（udf_kv）** 为事件携带的上下文参数，多个参数用分号分隔，格式为 `中文名 / 字段名`。udf_kv 是导入和管理层面的概念，分析时使用其下的具体 key 名。
- 触发时机列说明含义：`pv` = 页面可见，`click` = 点击，`change` = 切换/变更，`submit` = 表单提交，`expose` = 曝光。
---
### 1. 全局导航 & 页面浏览
| 触发时机 | 示意图 | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|---------|:----:|----------------|-------------|:----------:|----------------------|-------|
| pv（路由进入） | — | 页面曝光 / `dt_pgin` | 当前页面ID / `{pageId}` | — | `app_id` 应用ID；`biz_name` 产品名；`edition` 版本类型standard\|tabular；`ref_page_id` 来源页面ID | — |
| pv（路由离开） | — | 页面结束曝光 / `dt_pgout` | 当前页面ID / `{pageId}` | — | `app_id` 应用ID；`duration` 停留时长ms | — |
| click | — | 顶部导航切换 / `dt_clck` | 当前页面ID / `{pageId}` | 导航项名称 / `{navItem}` | `app_id` 应用ID；`target_module` 目标模块 | — |
| click | — | 左侧菜单切换 / `dt_clck` | 当前页面ID / `{pageId}` | 菜单项名称 / `{menuItem}` | `app_id` 应用ID；`menu_level` 菜单层级；`target_route` 目标路由名 | — |
| click | — | 全局搜索 / `dt_clck` | 当前页面ID / `{pageId}` | 搜索按钮 / `global_search_btn` | `app_id` 应用ID；`keyword` 搜索关键词 | — |
| click | — | Logo点击回首页 / `dt_clck` | 当前页面ID / `{pageId}` | Logo / `logo` | `app_id` 应用ID | — |
| click | — | 快捷指南打开 / `dt_clck` | 当前页面ID / `{pageId}` | 快捷指南 / `helper_btn` | `app_id` 应用ID | — |
| click | — | 反馈建议打开 / `dt_clck` | 当前页面ID / `{pageId}` | 反馈按钮 / `feedback_btn` | `app_id` 应用ID | — |
---
### 2. 首页 & 应用管理
| 触发时机 | 示意图 | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|---------|:----:|----------------|-------------|:----------:|----------------------|-------|
| pv（路由进入） | — | 首页进入 / `dt_pgin` | 首页 / `home` | — | `username` 用户名 | — |
| click | — | 版本选择 / `dt_clck` | 首页 / `home` | 轻量版\|标准版 / `{edition}` | — | — |
| click | — | 前往轻量版 / `dt_clck` | 首页 / `home` | 前往轻量版按钮 / `goto_lite_btn` | — | — |
| click | — | 前往标准版 / `dt_clck` | 首页 / `home` | 前往标准版按钮 / `goto_std_btn` | — | — |
| click | — | 体验Demo / `dt_clck` | 首页 / `home` | Demo按钮 / `try_demo_btn` | `edition` 版本 | — |
| pv（路由进入） | — | 工作台进入 / `dt_pgin` | 工作台 / `setup` | — | `app_count` 应用总数 | — |
| click | — | 切换我的/全部应用 / `dt_clck` | 工作台 / `setup` | Tab标签 / `{tab}` | `tab_type` mine\|all | — |
| click | — | 搜索应用 / `dt_clck` | 工作台 / `setup` | 搜索框 / `search_input` | `keyword` 关键词 | — |
| click | — | 应用卡片点击 / `dt_clck` | 工作台 / `setup` | 应用卡片 / `app_card` | `app_id` 应用ID；`app_name` 应用名；`mgmt_style` 管理模式 | — |
| click | — | 创建应用 / `dt_clck` | 工作台 / `setup` | 创建应用按钮 / `create_app_btn` | — | — |
| submit | — | 创建应用提交 / `setup_create_app_submit` | 工作台 / `setup` | 提交按钮 / `submit_btn` | `app_name` 应用名；`mgmt_style` 管理模式 | — |
| click | — | 申请权限 / `dt_clck` | 工作台 / `setup` | 申请权限按钮 / `apply_perm_btn` | `app_id` 应用ID | — |
| click | — | 埋点任务处理 / `dt_clck` | 工作台 / `setup` | 立即处理按钮 / `handle_btn` | `story_id` 需求ID；`app_id` 应用ID | — |
| click | — | 切换应用（顶部级联选择） / `dt_clck` | 当前页面ID / `{pageId}` | 应用选择器 / `app_cascader` | `app_id` 新应用ID；`old_app_id` 旧应用ID | — |
---


## 二、看板方案
### 模块 1：用户活跃概览
```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                            📊 用户活跃概览 Dashboard                                │
├─────────────────────┬─────────────────────┬─────────────────────┬───────────────────┤
│ 📈 今日DAU          │ 📈 今日PV           │ ⏱ 平均停留时长       │ 📊 本周WAU        │
│                     │                     │                     │                   │
│ 今日活跃用户数       │ 今日页面浏览量       │ 用户平均页面停留ms    │ 本周活跃用户数     │
├─────────────────────┴─────────────────────┴─────────────────────┴───────────────────┤
│                                                                                     │
│  📉 DAU 趋势图（最近30天折线图）                                                      │
│                                                                                     │
├─────────────────────────────────┬───────────────────────────────────────────────────┤
│ 🥧 版本分布                     │ 📊 TOP10 活跃应用                                  │
│ (标准版 vs 通用版 饼图)          │ (应用名 + PV 柱状图)                                │
└─────────────────────────────────┴───────────────────────────────────────────────────┘
```
**图卡计算逻辑：**
| 图卡 | 计算逻辑 (伪SQL) |
|------|-----------------|
| 今日DAU | `SELECT COUNT(DISTINCT user_id) FROM events WHERE event_code = 'dt_pgin' AND dt >= TODAY()` |
| 今日PV | `SELECT COUNT(*) FROM events WHERE event_code = 'dt_pgin' AND dt >= TODAY()` |
| 平均停留时长 | `SELECT AVG(CAST(duration AS BIGINT)) FROM events WHERE event_code = 'dt_pgout' AND dt >= TODAY()` |
| 本周WAU | `SELECT COUNT(DISTINCT user_id) FROM events WHERE event_code = 'dt_pgin' AND dt >= DATE_SUB(TODAY(), 7)` |
| DAU趋势图 | `SELECT dt, COUNT(DISTINCT user_id) AS dau FROM events WHERE event_code = 'dt_pgin' GROUP BY dt ORDER BY dt DESC LIMIT 30` |
| 版本分布 | `SELECT edition, COUNT(DISTINCT user_id) AS users FROM events WHERE event_code = 'dt_pgin' AND dt >= TODAY() GROUP BY edition` |
| TOP10活跃应用 | `SELECT app_id, COUNT(*) AS pv FROM events WHERE event_code = 'dt_pgin' AND dt >= TODAY() AND app_id IS NOT NULL GROUP BY app_id ORDER BY pv DESC LIMIT 10` |

**dt 是小时级分区字段，格式 `yyyyMMddHH`（如 `2026051320` = 2026年5月13日20时）, 注意年是要写4位， 月是2位， 日是2位、 时是2位**

### 模块 2：功能使用分析
```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                            📊 功能使用分析 Dashboard                                │
├─────────────────────┬─────────────────────┬─────────────────────┬───────────────────┤
│ 📈 导航点击总次数    │ 📈 搜索使用次数      │ 📈 应用创建次数      │ 📈 权限申请次数    │
│                     │                     │                     │                   │
│ 今日所有导航点击     │ 今日全局搜索使用     │ 今日创建应用数       │ 今日权限申请数     │
├─────────────────────┴─────────────────────┴─────────────────────┴───────────────────┤
│                                                                                     │
│  📊 各导航模块点击量分布（柱状图）                                                     │
│                                                                                     │
├─────────────────────────────────┬───────────────────────────────────────────────────┤
│ 🥧 菜单层级使用分布              │ 📉 搜索趋势（最近7天）                              │
│ (一级/二级/三级菜单占比)         │                                                    │
└─────────────────────────────────┴───────────────────────────────────────────────────┘
```
**图卡计算逻辑：**
| 图卡 | 计算逻辑 (伪SQL) |
|------|-----------------|
| 导航点击总次数 | `SELECT COUNT(*) FROM events WHERE event_code = 'dt_clck' AND dt_eid IN ('{navItem}', '{menuItem}') AND dt >= TODAY()` |
| 搜索使用次数 | `SELECT COUNT(*) FROM events WHERE event_code = 'dt_clck' AND dt_eid = 'global_search_btn' AND dt >= TODAY()` |
| 应用创建次数 | `SELECT COUNT(*) FROM events WHERE event_code = 'setup_create_app_submit' AND dt >= TODAY()` |
| 权限申请次数 | `SELECT COUNT(*) FROM events WHERE event_code = 'dt_clck' AND dt_eid = 'apply_perm_btn' AND dt >= TODAY()` |
| 各导航模块点击量分布 | `SELECT target_module, COUNT(*) AS clicks FROM events WHERE event_code = 'dt_clck' AND dt_eid IN ('{navItem}') AND dt >= TODAY() GROUP BY target_module ORDER BY clicks DESC` |
| 菜单层级使用分布 | `SELECT menu_level, COUNT(*) AS clicks FROM events WHERE event_code = 'dt_clck' AND dt_eid IN ('{menuItem}') AND dt >= TODAY() GROUP BY menu_level` |
| 搜索趋势 | `SELECT dt, COUNT(*) AS search_count FROM events WHERE event_code = 'dt_clck' AND dt_eid = 'global_search_btn' GROUP BY dt ORDER BY dt DESC LIMIT 7` |
```

---

**dt 是小时级分区字段，格式 `yyyyMMddHH`（如 `2026051320` = 2026年5月13日20时）, 注意年是要写4位， 月是2位， 日是2位、 时是2位**


## Prompt 生成检查清单

生成 Prompt 后，逐项检查：

- [ ] 引导语是否完整且包含 `======` 分隔符
- [ ] 约定说明是否完整（事件、页面、元素、私有参数 udf_kv、触发时机含义）
- [ ] 事件表格中每个事件都有 `中文 / 英文` 对照
- [ ] 无参数的事件 `udf_kv` 列填了 `—`
- [ ] 示意图 `ui` 列已填写（默认为 `—` 占位符）
- [ ] 说明 `remark` 列已填写（无需补充时为 `—`）
- [ ] 看板 ASCII 布局图中每个图卡都有对应的伪 SQL
- [ ] 伪 SQL 中引用的 event_code 与 Part 1 埋点方案中的英文名一致
- [ ] 伪 SQL 中引用的私有参数字段名与 Part 1 中对应事件的 `udf_kv` 中定义的具体 key 名完全一致
- [ ] 伪 SQL 中**不出现** `ext1`–`ext5`，全部使用 `udf_kv` 下的具体 key 名
- [ ] 伪 SQL 中**不直接引用** `udf_kv` 字段本身，而是使用其下的具体 key 名
- [ ] 伪 SQL 中需要数值计算的字段使用了 `CAST(字段名 AS BIGINT)`
- [ ] 时间条件使用了 `dt >= TODAY()` 或 `dt >= DATE_SUB(TODAY(), N)` 格式
- [ ] 伪 SQL 中除了自定事件外，不要出现 pgid + dt_pgin 或者 dt_eid + dt_clck 组合成一个event_code 条件，它们是两个条件，组合成一个event_code条件是错误用法
- [ ] 伪 SQL 部分后面有没有提示dt 是yyyyMMddHH格式，年是要写4位， 月是2位， 日是2位、 时是2位，这个非常重要
- [ ] 看板数量合理（通常 1-3 个，不宜过多）
