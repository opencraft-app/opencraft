# custom-specs（业务自定义「指标 & 埋点方案」规范目录）

本目录用于存放业务方自定义的**指标规划规范**与**埋点方案设计规范**。AI 在进行指标规划、埋点方案设计与文档产出时，会优先读取本目录下的 md 文件，并按约定优先级与 skill 内置默认规范合并。

> 与本目录**对称**的还有 `../custom-styles/` 目录，后者用于定制**上报代码的书写风格**。二者互不干扰、各司其职：
> - `custom-styles/`：代码怎么写（封装、调用姿势、命名约定）
> - `custom-specs/`：指标怎么规划、埋点方案怎么设计（命名规则、必选参数、必选指标、表格格式）

---

## 快速开始

1. 在本目录下新建一个或多个 `.md` 文件（文件名自由，但建议用关键词区分用途）：
   - 文件名含 `metric` / `indicator` → 识别为**指标规范**
   - 文件名含 `tracking` / `event` / `plan` → 识别为**埋点方案规范**
   - 文件名不匹配 → 作为通用补充参考
2. 在 md 中用二级标题声明**覆盖**或**补充**语义：
   - `## 覆盖`：对应章节会覆盖 skill 内置默认规范
   - `## 补充`：对应章节会与默认规范合并使用
   - 未声明时默认视为"补充"
3. 保存后，下次触发 skill 时自动生效，**无需**改动 skill 源码。

---

## 典型使用场景

- 公司统一要求所有 `event_code` 必须带业务线前缀（如 `biz_`）
- 所有事件必须携带公参 `tenant_id` / `user_tier`
- 指标清单必须包含合规/风控类必选指标
- 埋点方案表格必须额外增加"责任人"、"上线版本"列
- 公司 OKR / North Star 模板需要套用到指标规划输出

> 📖 完整的识别规则、优先级链、硬性约束清单见 `../references/custom-specs.md`
> 📖 完整的编写示例与编写指引见 `../附：业务如何扩展埋点 Skill 能力.md`

---

## 目录为空时的行为

如果本目录不存在、为空、或所有 md 均为空：

- skill 自动回退到内置默认规范（`references/tracking-plan.md` / `references/tracking-table-format.md` / `dashboard/references/metrics-planning.md` / `dashboard/references/scenario-library/`）
- 不会因本目录缺失而阻塞任何流程
- 产出文档头部会显式标注"使用默认规范（无业务自定义规范）"，便于审阅者确认未被意外跳过

---

## 硬性约束（不可被覆盖）

即使业务方在本目录声明"覆盖"，以下项也不会被采纳，AI 会在对话中提示冲突并保留默认：

- 事件主键三字段：`event_code` + `dt_pgid` + `dt_eid`
- `tracking-table-format.md` 中固定 7 列的**列名与语义**（`trigger` / `ui` / `event_code` / `dt_pgid` / `dt_eid` / `udf_kv` / `remark`）
- MCP 接口契约（工具名、入参 scheme）
- 大同标准事件名语义（`dt_pgin` / `dt_pgout` / `dt_imp` / `dt_imp_end` / `dt_clck`）

> ⚠️ 以上约束用于保证数据可分析性与平台兼容性。若确有业务需要，请联系大同平台维护者评估。
