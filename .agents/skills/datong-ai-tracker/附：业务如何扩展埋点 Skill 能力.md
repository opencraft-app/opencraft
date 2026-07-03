# 附：业务如何扩展埋点 Skill 能力

当前 Skill 基于大同 SDK 官方文档和通用实践。业务如有需要可自定义，让它更贴近业务实践。

Skill 提供**两类**并列的扩展能力，分别放在两个目录下：

| 扩展能力 | 目录 | 作用 | 消费场景 |
|---------|------|------|---------|
| **A. 指标 / 埋点方案规范扩展** | `custom-specs/` | 定制"指标怎么规划、埋点方案怎么设计" | 指标规划、埋点方案设计、方案文档与指标清单产出 |
| **B. 代码风格扩展** | `custom-styles/` | 定制"上报代码怎么写" | 埋点代码生成（封装工具类、调用姿势、命名约定） |

两类扩展都是**新增即生效**、**删除即回退默认**，不需要改 skill 源码。

---

## A. 指标 / 埋点方案规范扩展（custom-specs/）

通过在 `custom-specs/` 目录下添加文档，让 AI 在规划指标、设计埋点方案、产出方案文档与指标清单时，按你公司的规范执行（命名规则、必选公参、必选指标、附加列等）。

> 📖 完整的识别规则、优先级链、硬性约束见 `references/custom-specs.md`

### 如何添加

1. 在 `custom-specs/` 目录下创建 `.md` 文件
2. **文件名关键词**决定 AI 在什么场景读取（不区分大小写）：
   - 文件名含 `metric` / `indicator` / `kpi` / `okr` / `northstar` → 识别为**指标规范**，在指标规划环节读取
   - 文件名含 `tracking` / `event` / `plan` / `param` / `naming` → 识别为**埋点方案规范**，在埋点方案设计环节读取
   - 关键词都不命中 → 作为**通用补充**，两类场景都读取
3. 在文档内用二级标题显式声明每个章节的意图：
   - `## 覆盖`（或 `## Override`）：**整段替换** skill 默认规则
   - `## 补充`（或 `## Append`）：与默认规则**叠加使用**
   - 未声明 → 默认视为"补充"
4. 保存后下次触发 skill 时自动生效，**无需**改动 skill 源码

### 指标规范编写示例

建议命名：`metrics-spec.md` / `indicator-spec.md`

```markdown
# XX业务指标规划规范

## 覆盖：指标分类体系

公司统一使用「OKR 对齐 / 业务健康度 / 风控合规 / 护栏」四级分类，不使用默认的
「北极星 / 核心 / 诊断 / 护栏」分类。

- OKR 对齐：与当季公司 OKR 直接挂钩的指标
- 业务健康度：反映业务状态的综合指标
- 风控合规：合规部门要求必须统计的指标
- 护栏：用于识别体验劣化的指标

## 补充：必选指标（所有项目必须包含）

| 指标名 | 分类 | 计算方式 | 所需埋点 |
|-------|------|---------|---------|
| 租户健康分 tenant_health_score | 业务健康度 | 活跃用户数 / 付费租户总数 | 需要 dt_pgin + tenant_id |
| 风控命中率 risk_hit_rate | 风控合规 | 触发风控次数 / 总请求数 | 需要自定义事件 risk_hit |

## 补充：禁用指标

以下指标类在公司规范中**不推荐**，请从推荐结果中剔除：

- 单纯的 PV / UV（信息量低，已被租户维度指标替代）
- 停留时长类指标（技术口径差异大，数据不可信）

## 补充：指标清单附加列

除默认列外，指标清单必须额外包含：

| 附加列名 | 说明 |
|---------|------|
| 负责人 | 该指标的业务 owner |
| OKR 对齐 | 对齐到哪个公司级 OKR（Q1-O1 / Q1-O2 等） |
| 审核状态 | 是否已通过数据委员会评审（pending / approved） |
```

### 埋点方案规范编写示例

建议命名：`tracking-spec.md` / `event-naming.md`

```markdown
# XX业务埋点方案设计规范

## 覆盖：事件命名规则

所有自定义事件的 event_code 必须符合以下规则：

- 必须以 `biz_` 前缀开头
- 使用 snake_case
- 业务域前缀在 `biz_` 之后，如 `biz_order_submit` / `biz_pay_success`
- 禁止使用驼峰、大写、连字符

大同标准事件名（`dt_pgin` / `dt_pgout` / `dt_imp` / `dt_imp_end` / `dt_clck`）保持原样。

## 补充：必选公参

所有事件（含 SDK 自动采集事件）的 udf_kv 必须携带以下公参：

| 参数 key | 含义 | 取值来源 |
|---------|------|---------|
| tenant_id | 当前登录租户 ID | localStorage.tenantId |
| user_tier | 用户等级（free / pro / enterprise） | localStorage.userTier |
| app_env | 环境标识（prod / staging / dev） | 构建时注入 |

## 补充：自定义事件分类

除默认 5 类（页面曝光 / 元素曝光 / 元素点击 / 业务自定义 / 性能） 外，新增一类：

- **合规事件 compliance**：涉及 GDPR / 个保法 / 数据出境等合规链路的行为上报，event_code 必须以 `biz_compliance_` 开头

## 补充：埋点方案表格附加列

在默认 7 列（trigger / ui / event_code / dt_pgid / dt_eid / udf_kv / remark）右侧追加：

| 附加列名 | 说明 |
|---------|------|
| 责任人 | 该埋点的研发 owner |
| 上线版本 | 计划上线的版本号（如 v2.8.0） |
| 审核人 | 数据 BP 审核通过的同事 |

## 补充：方案文档文件名格式

使用 `{YYYYMMDD}-{slug}-{owner}.md`，owner 为埋点负责人英文名。
```

---

## B. 代码风格扩展（custom-styles/）

通过在 `custom-styles/` 目录下添加文档，让 AI 生成的上报代码符合你的业务写作风格。

### 如何添加

1. 在 `custom-styles/` 目录下创建 `.md` 文件（如 `my-project-style.md`）
2. 按照下方示例格式编写内容
3. 保存后 AI 会自动在生成代码时优先参考

### 编写示例

以下是一个完整的业务代码风格文档示例，你可以参考这个格式来编写：

```markdown
# XX业务上报代码规范

## 封装工具类

项目统一使用 `ReportManager` 进行上报，文件位置：`com.example.report.ReportManager`

## 调用示例

### 页面曝光上报

```kotlin
// 在 Activity.onResume() 中调用
ReportManager.reportPageExpose(
    pageId = "home_page",
    params = mapOf(
        "tab_index" to "0",
        "source" to "push"
    )
)
```

### 点击事件上报

```kotlin
// 按钮点击时调用
ReportManager.reportClick(
    elementId = "submit_btn",
    params = mapOf(
        "button_text" to "提交",
        "position" to "bottom"
    )
)
```

## 命名规范

- 页面 ID：使用下划线分隔，如 `home_page`、`detail_page`
- 元素 ID：使用下划线分隔，如 `submit_btn`、`banner_card`
- 参数 key：使用下划线分隔，全小写

## 注意事项

- 所有上报必须在主线程调用
- params 中不要传入 null 值，使用空字符串代替
```

---

## 可定制 / 不可定制清单

### ✅ 可定制（在 `custom-specs/` 中声明即可生效）

- 事件命名规则、event_code 前缀风格、参数 key 风格
- 必选公参清单、必选指标清单、禁用指标清单
- 指标分类体系、场景打分规则、计算口径模板
- 埋点方案表格附加列、方案文档文件名格式、附加章节
- 指标清单附加列（负责人 / OKR 对齐 / 审核状态 等）

### ❌ 不可定制（硬性约束，即使声明"覆盖"也会被拒绝）

- **`event_code` 必须作为埋点主键**，任何事件都不得省略或替换；主键三字段为 `event_code` + `dt_pgid` + `dt_eid`
- `tracking-table-format.md` 固定 7 列的**列名与语义**（可追加列，但不可删减、更名、换序）
- 大同标准事件名语义：`dt_pgin` / `dt_pgout` / `dt_imp` / `dt_imp_end` / `dt_clck`
- MCP 接口契约（工具名、入参 scheme）

> 被拒绝的条目会在产出文档头部「规范来源」块中显式列出，方便你确认未被意外跳过。  
> 详细原因见 `references/custom-specs.md` 第 4 节。

---

## 「覆盖 vs 补充」写法说明

业务规范写法的三种语义，通过**二级标题**显式声明：

| 二级标题 | 语义 | 适用场景 |
|---------|------|---------|
| `## 覆盖：XXX` | 整段替换默认规则中 XXX 这一项 | 想换成公司全新规则（如重写指标分类体系） |
| `## 补充：XXX` | 与默认规则叠加使用 | 想在默认基础上加约束（如追加必选公参） |
| `## XXX`（不声明） | 默认视为"补充" | 懒人写法，与叠加使用同义 |

> ⚠️ 建议总是显式声明"覆盖"或"补充"，避免歧义。

---

## 如何验证自定义规范已被采纳

每份 AI 产出的文档（`dt_tracking_plan/` 下的埋点方案文档、指标清单）头部，**必然**会包含一个「规范来源」块：

```markdown
> **规范来源**
> - 自定义规范文件：tracking-spec.md, metrics-spec.md
> - 已应用规则：
>   - event_code 前缀 = biz_（来自 tracking-spec.md 覆盖）
>   - 所有事件携带必选公参 tenant_id / user_tier / app_env（来自 tracking-spec.md 补充）
>   - 必选指标 tenant_health_score、risk_hit_rate（来自 metrics-spec.md 补充）
> - 被拒绝覆盖的条目（如有）：
>   - 业务尝试删除 dt_pgid 列，已拒绝；原因：数据底层硬性约束
```

**检查方法：**

1. 打开 AI 生成的方案文档或指标清单
2. 看头部「规范来源」块是否列出了你写的 md 文件名
3. 看「已应用规则」是否覆盖了你期望的规则
4. 若「自定义规范文件」固定写作「无（使用默认规范）」 → 表示 AI 没读到你写的文件，请检查文件名是否符合关键词匹配规则

> 📖 「规范来源」块的完整格式定义见 `references/custom-specs.md` 第 6 节。

---

## 参考优先级（全链路）

AI 在整条链路（指标规划 → 埋点方案 → 上报代码）中的参考顺序：

| 阶段 | 🥇 P1（最高） | 🥈 P2 | 🥉 P3（兜底） |
|------|--------------|-------|--------------|
| **指标规划** | `custom-specs/` 下指标规范 md | 项目已有指标产出 | skill 默认 `metrics-planning.md` + 场景库 |
| **埋点方案设计** | `custom-specs/` 下埋点方案规范 md | 项目 `dt_tracking_plan/` / `dt_tracking_info/` 下已有产出 | skill 默认 `tracking-plan.md` + `tracking-table-format.md` |
| **上报代码生成** | `custom-styles/` 下代码风格 md | 项目中已有的上报代码 | SDK 官方文档 |

> 📌 阶段顺序与本文档 A / B 章节顺序一致：先规划指标 & 埋点方案（A），再生成上报代码（B）。

> 💡 P1 未覆盖 / 留空的项，自动用 P2 兜底；P2 也没有的再用 P3。全链路不会因为 P1 空缺而阻塞。
