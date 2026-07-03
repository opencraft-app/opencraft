# 埋点事件表格格式规范

本文档定义埋点事件表格文档规范：

> 🔀 **【前置】检查业务自定义表格格式（custom-specs/）**  
> 生成表格前，先执行 `custom-specs/` 前置检查（详见 [custom-specs.md](./custom-specs.md)）：  
> 1. 若业务自定义规范声明了**附加列**（如「责任人」、「上线版本」、「审核状态」） → 在默认 7 列右侧**追加**这些列  
> 2. 若业务自定义规范声明了**列对齐方式**或**列内格式** → 采纳自定义格式  
> 3. 默认 7 列（`trigger` / `ui` / `event_code` / `dt_pgid` / `dt_eid` / `udf_kv` / `remark`）的**列名与语义属硬性约束**，不可被删减、更名或替换顺序；即使自定义规范声明"覆盖"也**拒绝采纳**  
> 4. 未被自定义规范覆盖的格式项 → 沿用本文档默认规则  
> 5. 目录不存在或无命中 → 完全按本文档默认规则执行

## 表格结构

埋点事件表格将所有事件概览信息和参数详情整合到一张扁平表中，每个事件占一行。固定 **7 列**，私有参数在同一格内用英文分号 `;` 分隔。

## 表头格式（固定，不可修改）

```markdown
| 触发时机 trigger | 示意图 ui | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|----------|:----:|---------|---------|:------------:|-------|-------|
```

- 示意图 ui 列居中对齐 (`:----:`)
- 元素 dt_eid 列居中对齐 (`:----:`)
- 其他列左对齐

## 列定义

| 列名 | 说明 | 格式 |
|------|------|------|
| 触发时机 trigger | 触发上报的时间点描述，只需中文 | 自然语言描述 |
| 示意图 ui | 事件触发位置的界面示意，用于辅助理解 | 占位符 `—`（后续可替换为截图链接或文字描述） |
| 事件 event_code | event_code + 中文名，中英文都要 | `` `event_code` 中文名 `` |
| 页面 dt_pgid | 事件发生的页面，中英文都要；无关联页面时置空填 `—` | `` `dt_pgid` 页面中文名 `` 或 `—`（无页面时） |
| 元素 dt_eid | 触发元素标识，中英文都要；无关联元素时置空填 `—` | `` `element_name` `` 或 `—`（无元素时） |
| 私有参数 udf_kv | 事件携带的全部私有参数 | 多个参数用英文分号 `;` 分隔，每个参数格式: `` `param_key` 中文释义 `` |
| 说明 remark | 对该条埋点事件的补充说明 | 自然语言描述，无需补充时填 `—` |

> ⚠️ `event_code` + `dt_pgid` + `dt_eid` 三字段组成数据库主键，唯一确定一条事件，**一旦确定不要轻易修改**。无关联的字段置空（表格中填 `—`）。

## 格式规则

### 触发时机 trigger 列
- 只需要中文自然语言描述
- 格式: `用户点击侧边栏导航菜单项时`

### 示意图 ui 列
- 用于辅助理解事件触发位置的界面示意
- 默认填占位符 `—`，后续可替换为截图链接或文字描述
- 格式: `—` 或具体描述/链接

### 事件 event_code 列
- 将 event_code（用反引号包裹）和中文事件名合并在一列
- 格式: `` `dt_pgin` 页面曝光 ``
- 两者之间用空格分隔
- ⚠️ **每行只能有一个 event_code**，严禁将多个事件合并到同一行（如 `dt_pgin` 和 `dt_pgout` 虽然是同一页面的进入/退出事件，也必须分成两行独立记录）
- ⚠️ 该列中只允许出现一个反引号包裹的英文名，出现 `/`、`+`、`&`、`和`、`及` 等连接符连接多个事件名的写法均视为违规
- 标准事件

### 页面 dt_pgid 列
- dt_pgid（用反引号包裹）+ 页面中文名
- 格式: `` `home` 首页 ``
- 无关联页面时填 `—`
- ⚠️ **严禁将多个 dt_pgid 合并到同一行**，即使事件名称相同（如多个页面都有 `dt_pgin`），也必须每个 dt_pgid 独立一行。因为 `event_code` + `dt_pgid` + `dt_eid` 是数据库主键，每个组合必须对应表格中的一行

### 元素 dt_eid 列
- 元素标识用反引号包裹
- 格式: `` `nav_menu` `` 或 `—`（无元素时）
- ⚠️ **严禁将多个 dt_eid 合并到同一行**，每个 dt_eid 独立一行，理由同上

### 私有参数 udf_kv 列
- 所有参数合并在同一格内
- 每个参数格式: `` `param_key` 中文释义 ``
- 多个参数之间用英文分号 `;` 分隔
- 格式示例: `` `page_name` 所在页面；`event_id` 事件ID；`event_name` 事件名称 ``
- ⚠️ `udf_kv` 是导入和管理层面的概念标识。在分析和看板伪 SQL 中，使用的是 `udf_kv` 下的具体 key 名（如 `page_name`、`event_id`）作为查询条件，而非引用 `udf_kv` 字段本身

### 说明 remark 列
- 对该条埋点事件的补充说明
- 自然语言描述，无需补充时填 `—`
- 可用于记录特殊逻辑、注意事项、业务背景等

## 核心原则：一行一主键

**`event_code` + `dt_pgid` + `dt_eid` 是数据库主键**，每个唯一组合必须在表格中占独立一行。

❌ **错误示例**（多个 dt_pgid 合并到一行）：

```markdown
| 路由进入页面时 | — | `dt_pgin` 页面曝光 | `home` 首页 / `post_detail` 详情页 / `settings` 设置 | — | `page_name` 页面名称标识 | — |
```

✅ **正确示例**（每个 dt_pgid 独立一行）：

```markdown
| 路由进入页面时 | — | `dt_pgin` 页面曝光 | `home` 首页 | — | `page_name` 页面名称标识 | — |
| 路由进入页面时 | — | `dt_pgin` 页面曝光 | `post_detail` 详情页 | — | `page_name` 页面名称标识 | — |
| 路由进入页面时 | — | `dt_pgin` 页面曝光 | `settings` 设置 | — | `page_name` 页面名称标识 | — |
```

> 即使触发时机和事件名称完全相同，只要 dt_pgid 或 dt_eid 不同，就必须分开写成多行。

### 主键不可重复

**整张表中不允许出现两行或多行拥有完全相同的 `event_code` + `dt_pgid` + `dt_eid` 组合**（`—` 视为空值参与比较）。

- 如果同一页面下的同一元素有多种触发场景（如"加购"和"减购"都点击同一按钮），必须通过**不同的 `dt_eid`** 区分（如 `dish_plus_btn` vs `dish_minus_btn`），而非写两行相同主键
- 如果确实是同一个交互行为只是参数不同，应**合并为一行**，参数差异通过 `udf_kv` 的参数值体现

❌ **错误示例**（主键重复）：

```markdown
| 用户点击加购按钮时 | — | `dt_clck` 元素点击 | `shop_detail` 商家详情页 | `dish_btn` | `dish_id` 菜品ID；`action` 加购 | — |
| 用户点击减购按钮时 | — | `dt_clck` 元素点击 | `shop_detail` 商家详情页 | `dish_btn` | `dish_id` 菜品ID；`action` 减购 | — |
```

✅ **正确示例**（通过不同 dt_eid 区分）：

```markdown
| 用户点击加购按钮时 | — | `dt_clck` 元素点击 | `shop_detail` 商家详情页 | `dish_plus_btn` | `dish_id` 菜品ID；`dish_name` 菜品名称；`price` 单价 | — |
| 用户点击减购按钮时 | — | `dt_clck` 元素点击 | `shop_detail` 商家详情页 | `dish_minus_btn` | `dish_id` 菜品ID | — |
```

## 完整示例

```markdown
| 触发时机 trigger | 示意图 ui | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|----------|:----:|---------|---------|:------------:|-------|-------|
| 路由进入页面时 | — | `dt_pgin` 页面曝光 | `home` 首页 | — | `page_name` 页面名称标识 | — |
| 路由进入页面时 | — | `dt_pgin` 页面曝光 | `post_detail` 详情页 | — | `page_name` 页面名称标识 | — |
| 路由进入页面时 | — | `dt_pgin` 页面曝光 | `event_manage` 事件管理 | — | `page_name` 页面名称标识 | — |
| 路由离开页面时 | — | `dt_pgout` 页面结束曝光 | `home` 首页 | — | `page_name` 页面名称标识；`stay_duration` 页面停留时长(ms) | — |
| 路由离开页面时 | — | `dt_pgout` 页面结束曝光 | `post_detail` 详情页 | — | `page_name` 页面名称标识；`stay_duration` 页面停留时长(ms) | — |
| 路由离开页面时 | — | `dt_pgout` 页面结束曝光 | `event_manage` 事件管理 | — | `page_name` 页面名称标识；`stay_duration` 页面停留时长(ms) | — |
| 用户点击侧边栏导航菜单项时 | — | `dt_clck` 元素点击 | — | `nav_menu` 导航菜单 | `target_page` 目标页面 | — |
| 用户点击帖子卡片时 | — | `dt_clck` 元素点击 | `home` 首页 | `post_card` 帖子卡片 | `post_id` 帖子ID；`post_title` 帖子标题 | — |
| 用户在弹窗中提交创建事件表单时 | — | `event_create` 创建事件 | `event_manage` 事件管理 | — | `event_name` 创建的事件名称；`event_category` 事件类型；`param_count` 参数数量 | — |
| 用户提交搜索时 | — | `search_confirm` 搜索确认 | — | — | `keyword` 搜索关键词；`result_count` 结果数量 | — |
```
**注意**： 
1、标准事件的中英文名都是固定，不可以随意更改， 标准事件： `dt_pgin` 页面曝光、`dt_pgout` 页面结束曝光、`dt_clck` 元素点击、 `dt_imp` 元素曝光、 `dt_imp_end` 元素结束曝光、`dt_vst` 应用有效访问、 `dt_appin` 应用进入、 `dt_appout` 应用退出
2、除了标准事件以外，其他都是自定义事件，自定义事件的中英文名请根据语义或上下文命名既可

## 文件位置与命名

生成的表格应保存到项目根目录下的 `dt_tracking_plan/` 目录（不存在则创建）。

**文件名沿用 Step 1b 生成的同一份文件**（即 `{summary-slug}-YYYYMMDDHH.md`），Step 3b 只是把分页面列表式覆盖改写为表格式，**不改文件名**。

- 示例：`content-feed-tracking-2026042022.md`、`ecommerce-checkout-tracking-2026042022.md`
- `{summary-slug}`：模型对本次埋点需求起的总结性短标题（kebab-case 英文，2-5 词，体现业务场景/主题）
- 详见 `tracking-plan.md` 的「方案文档保存规则」

## 文件内容结构

Step 3b 产出的文件**只包含 `## 埋点事件表` + 表格数据**，不允许有任何其他内容。

### 默认结构（只有埋点事件表）

```markdown
## 埋点事件表

| 触发时机 trigger | 示意图 ui | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|----------|:----:|---------|---------|:------------:|-------|-------|
| ... | — | ... | ... | ... | ... | ... |
| ... | — | ... | ... | ... | ... | ... |
```

> ⚠️ **文件第一行必须是 `## 埋点事件表`，紧跟表头和数据行，文件到表格最后一行结束。**
>
> ❌ **以下内容严禁出现在最终文件中**：
> - `# 标题`（一级标题，如 `# XXX埋点方案`）
> - `> **规范来源**` 或任何 `>` 引用块
> - `## 设计依据`、`## 指标 → 事件映射` 或类似的指标说明章节
> - `## SDK 选择`、`## 项目分析`、`## 技术栈` 等过程性说明
> - `---` 分隔线
> - 表格以外的任何文字说明

### 可选结构（用户明确要求附上指标方案时）

当用户明确要求附上指标方案时，在埋点事件表后追加 `## 附：指标方案` 章节：

```markdown
## 埋点事件表

| 触发时机 trigger | 示意图 ui | 事件 event_code | 页面 dt_pgid | 元素 dt_eid | 私有参数 udf_kv | 说明 remark |
|----------|:----:|---------|---------|:------------:|-------|-------|
| ... | — | ... | ... | ... | ... | ... |
| ... | — | ... | ... | ... | ... | ... |

## 附：指标方案

> 本次埋点围绕以下业务指标设计（来自 Step 0b 用户确认）。

**命中场景**：{场景名}（若 Step 0b 未命中场景则填「通用指标模板」）

| 序号 | 指标名称 | 指标类型 | 业务含义 | 所需核心事件 | 计算逻辑（伪SQL） |
|:----:|---------|:-------:|---------|-------------|-------------|
| 1 | ... | 北极星 | ... | `dt_pgin`(`home`); `search_confirm`(—/—) | `SELECT COUNT(DISTINCT user_id) FROM events WHERE event_code = 'dt_pgin' AND dt_pgid IN ('home', 'post_detail') AND dt >= TODAY()` |
| 2 | ... | 核心 | ... | `dt_clck`(`home`/`post_card`) | `SELECT COUNT(*) FROM events WHERE event_code = 'dt_clck' AND dt_eid = 'post_card' AND dt_pgid = 'home' AND dt >= TODAY()` |
```

### 「所需核心事件」列填写规则（仅附上指标方案时适用）

> ⚠️ 以下规则仅在用户明确要求附上指标方案附录时适用。默认不生成指标附录。

- 必须使用 **`event_code` + `dt_pgid` + `dt_eid` 三字段主键组合**引用事件，格式：`` `event_code`(`dt_pgid`/`dt_eid`) ``
- 无关联的字段用 `—` 占位，如 `` `search_confirm`(—/—) `` 表示 dt_pgid 和 dt_eid 均为空
- 同一指标依赖多个事件时，用英文分号 `;` 分隔
- 事件名用反引号包裹，必要时追加中文说明
- **严禁**只写事件名不带 dt_pgid/dt_eid 定位（如 `dt_pgin`、`dt_clck`），因为同一 event_code 常会在多个 dt_pgid/dt_eid 下占多行，无定位无法精确依赖
- **严禁**引用不存在的事件主键组合；Step 3b 生成附录时必须回扫主体表逐条核对

**示例对照**：

| 写法 | 合规性 | 说明 |
|------|:------:|------|
| `` `dt_pgin`(`home`/—); `dt_pgin`(`post_detail`/—); `dt_pgin`(`event_manage`/—) `` | ✅ | 明确依赖到具体事件主键 |
| `` `dt_clck`(`home`/`post_card`); `search_confirm`(—/—) `` | ✅ | 带页面和元素定位的完整形式 |
| `dt_pgin`; `dt_clck` | ❌ | 缺主键定位，同名事件有多行时无法定位 |
| `dt_pgin`(第 1、2 行) | ❌ | 不再使用行号引用 |

### 「计算逻辑（伪SQL）」列填写规则（仅附上指标方案时适用）

- **为什么**：业务含义只说「是什么指标」，伪 SQL 说清「这个指标到底怎么算出来」，便于日后对数据、复盘、切换到大同平台后直接映射成查询
- **表结构假设**（与 `dashboard/references/dashboard-prompt.md` 中看板侧伪 SQL 规范保持一致）：
  - 明细表名固定写作 `events`
  - 事件名字段 `event_code`（对应主体表「事件 event_code」列反引号内容）
  - 页面标识字段 `dt_pgid`（对应主体表「页面 dt_pgid」列反引号内容）
  - 元素标识字段 `dt_eid`（对应主体表「元素 dt_eid」列反引号内容）
  - 私有参数字段直接使用 `udf_kv` 下的具体 key 名（如 `article_id`、`category_name`），对应主体表「私有参数 udf_kv」列中反引号包裹的字段名。**严禁使用 `ext1`–`ext5` 等物理列名，也严禁直接引用 `udf_kv` 字段本身**
  - 日期分区字段 `dt`，常用 `dt >= TODAY()` / `dt >= DATE_SUB(TODAY(), N)`
- **常用算子**（与看板侧保持同一套语言）：`COUNT(*)` / `COUNT(DISTINCT field)` / `AVG(CAST(字段名 AS BIGINT))` / `GROUP BY` / `ORDER BY ... LIMIT N`
- **引用一致性**：伪 SQL 中出现的 `event_code`、`dt_pgid`、`dt_eid`、私有参数字段名 必须与「所需核心事件」里引用的事件在主体表中的取值完全一致
- **书写风格**：单行即可，整体用反引号包裹成内联代码；过长指标可以拆成两段但不要换行破坏表格

**示例对照**：

| 写法 | 合规性 | 说明 |
|------|:------:|------|
| `` `SELECT COUNT(DISTINCT user_id) FROM events WHERE event_code = 'dt_pgin' AND dt_pgid = 'home' AND dt >= TODAY()` `` | ✅ | 表、字段、算子都符合规范 |
| `` `SELECT COUNT(*) FROM events WHERE event_code = 'dt_clck' AND dt_eid = 'post_card'` `` | ✅ | 元素级点击计数 |
| `` `SELECT category_name, COUNT(*) AS clicks FROM events WHERE event_code = 'dt_clck' AND dt_eid = 'category_tab' GROUP BY category_name` `` | ✅ | 使用 udf_kv 下的具体 key `category_name` |
| `` `SELECT AVG(CAST(duration AS BIGINT)) FROM events WHERE event_code = 'dt_pgout'` `` | ✅ | 使用 udf_kv 下的具体 key `duration` |
| `` `SELECT ext1 AS category_name, COUNT(*) FROM events ...` `` | ❌ | **严禁使用 ext1–ext5**，必须用具体 key 名 |
| `` `SELECT udf_kv.category_name FROM events ...` `` | ❌ | **严禁直接引用 udf_kv 字段**，直接用具体 key 名 |
| 按 dt_pgin 数量算 | ❌ | 自然语言描述，非伪 SQL |
| `SELECT * FROM 埋点表 ...` | ❌ | 表名必须写作 `events`，字段用规范约定 |

> 📖 伪 SQL 的表/字段/算子完整清单见 `../dashboard/references/dashboard-prompt.md` 的「伪 SQL 规范」章节，埋点侧与看板侧共用同一套语言。

> ⚠️ 指标附录只在用户明确要求时才生成。生成时只贴用户**最终确认**的那一版清单；若用户跳过指标推荐/选择穷举路径，则省略此附录，只保留主体表格。
> ⚠️ 除埋点事件表（和可选的指标附录）外不要多余的说明文档。
