# Hermes Blueprint 自动任务模板目录升级设计

## 背景

LightVela 的自动任务底层已经使用 Hermes Cron。现网实例验证显示 Hermes Agent 0.20.3 已包含 16 个官方 Automation Blueprint，但自动任务页仍只展示前端维护的 12 个 LightVela 模板，没有读取运行时 Catalog。

本次升级同时解决两个问题：升级现有模板的内容呈现，并补充 Hermes 已提供但 LightVela 尚未展示的模板。

## 目标

- 国内站与国际站自动任务页使用同一套目录能力，并分别显示中文和英文内容。
- 保留 LightVela 已有的本地化场景，不因接入官方 Catalog 而退化。
- 从当前 Agent 的 Hermes 运行时读取官方 Blueprint，避免复制一份容易过期的数据。
- 合并语义重叠的模板，避免用户看到两张用途几乎相同的卡片。
- 模板卡片说明“会做什么、何时运行、何时通知、依赖什么”，提升真实感与可理解性。
- Hermes Catalog 读取失败时继续显示 LightVela 模板，不阻断自动任务管理。

## 非目标

- 本次不升级 Hermes 实例版本。
- 本次不创建、迁移或修改用户已有 Cron Job。
- 本次不新增独立模板数据库或运营后台。
- 本次不实现完整的 Hermes `hermes://` Deep Link 协议。
- 本次不改变当前 Cron 创建、编辑、暂停、恢复和删除语义。

## 方案

### 1. 双来源目录

目录由两个来源组成：

1. LightVela 精选模板：继续使用现有 `ScenarioTaskPack` 和 legacy 模板，覆盖用药、交租、汇率、健身、节假日、股票等本地化场景。
2. Hermes 官方 Blueprint：通过现有 `debug/exec` 通路，在当前 Agent 运行时调用 `cron.blueprint_catalog`，一次返回 Catalog 卡片信息和默认填充后的 Cron spec。

运行时读取脚本只做 Python import 和 JSON 输出，不写文件、不创建任务。返回字段包括：

- `key`
- `title`
- `description`
- `category`
- `tags`
- `fields`
- `scheduleHuman`
- 默认填充后的 `name / prompt / schedule / deliver / skills`

### 2. 统一前端模型

新增独立的模板目录模块，将两个来源归一为统一模型：

```ts
interface AutomationCatalogTemplate {
  id: string;
  source: "lightvela" | "hermes";
  name: string;
  description: string;
  category: string;
  tags: string[];
  prompt: string;
  schedule: AutomationSchedule;
  scheduleLabel: string;
  deliver?: string;
  skills: string[];
  notificationPolicy: "always" | "only-when-needed";
  previewKind: AutomationTemplatePreviewKind;
}
```

运行时数据只通过解析器进入 UI。字段缺失、类型不符或 Blueprint 无法填充时跳过该条并保留其他模板。

### 3. 重叠合并

以下 Hermes Blueprint 不单独重复展示，而是用于升级对应 LightVela 模板的说明、标签或默认能力：

| Hermes Blueprint | LightVela 模板 |
| --- | --- |
| `hydration-move` | 喝水与吃药提醒、久坐活动提醒 |
| `weekly-review` | 周五工作复盘 |
| `workday-start` | 每日待办整理、起床提醒 |
| `news-digest` | 每日 AI 资讯摘要 |
| `bill-renewal-watch` | 交租提醒 |
| `habit-checkin` | 卡路里与健身记录 |

其余官方模板作为新增模板进入目录：晨间简报、重要邮件监控、自定义提醒、晚间收尾、价格与库存监控、竞品动态监控、每周膳食计划、每日学习、感恩复盘、历史上的今天。

目录预计由现有 12 个升级模板与 10 个新增模板组成，共 22 个；若某台 Agent 缺少 Catalog，则仅显示现有 12 个。

### 4. 双站文案

- 国内站优先使用 LightVela 中文名称与描述。
- 国际站使用英文名称与描述。
- 其他语言站点暂时复用已有 LightVela 本地化；新增 Hermes 模板在没有对应翻译时回退英文。
- Cron Prompt 使用当前 Agent 运行时返回的官方默认 Prompt，不在翻译过程中改写执行语义。

### 5. 页面呈现

保留已确认的低圆角外层卡片与每页 6 张模板卡片，新增：

- 分类筛选：全部、日常、工作效率、监控提醒、健康生活、学习成长。
- 卡片顶部“产物示意区”：使用轻量、静态的真实结果摘要，不使用大图、渐变或动画。
- 卡片正文：名称、价值描述、运行频率。
- 条件型任务显示“满足条件才通知”。
- 有 Skill 依赖时显示依赖名称；没有依赖时不占位。
- 来源仅在详情/辅助信息中显示“LightVela 精选”或“Hermes 官方”，避免抢占主视觉。

卡片仍以整卡按钮启用，维持键盘可访问性和现有分页行为。分类切换后从第一页重新开始。

### 6. 启用流程

- LightVela 模板沿用当前创建流程。
- Hermes 模板使用运行时返回的默认 Cron spec 打开同一个新建任务表单。
- 用户仍可在保存前修改名称、Prompt、时间和投递位置。
- 保存时继续调用现有 `hermes cron create`；有上下游依赖时继续调用官方 `cronjob` tool。
- 本次不直接执行 `/blueprint`，避免产生第二条创建链路。

### 6.1 简洁任务说明与内部默认规则

- 所有模板的任务说明只展示用户真正需要修改的对象、条件和期望结果。
- 去重、仅在必要时通知、无变化时返回 `[SILENT]`、来源校验等 Hermes 执行约束由模板内部默认规则补充，不在任务说明中展开。
- 监控类模板的任务说明控制为一到两句；其他模板也移除执行步骤、格式说明和技术术语。
- 创建与测试运行时仍向 Hermes 发送“简洁任务说明 + 内部默认规则”，不改变现有 Cron 创建链路。

### 7. 加载与错误处理

- 页面先立即展示 LightVela 模板，再异步加载 Hermes Catalog。
- 加载期间不显示整块 Skeleton，避免已有模板闪烁或位移。
- Catalog 成功后合并目录并保持当前分类；页码超过新总页数时归一到最后一页。
- 运行时缺少模块、实例离线、鉴权失败或 JSON 解析失败时静默回退现有模板；任务列表错误仍按原逻辑展示。
- 不把命令输出、实例路径或 Python 错误暴露给普通用户。

## 数据观测

现有埋点继续记录 `template_id`，并新增 `template_source`、`template_category`。创建成功事件需要记录相同字段，才能区分卡片点击和实际启用。

模板来源暂不写入 Hermes `jobs.json`。后续若需要按存量任务统计模板使用率，再设计独立的 Job metadata 持久化方案。

## 测试与验收

- 单元测试覆盖 Catalog JSON 解析、异常条目跳过、来源合并和重叠去重。
- 组件测试覆盖 22 个模板、分类筛选、分页复位、中文/英文文案和运行时失败降级。
- 创建流程测试确认 Hermes 模板默认 spec 能正确预填现有表单，但不会在点击卡片时直接创建任务。
- 回归现有任务列表、已结束任务、最近执行、暂停/恢复和模板折叠状态。
- 运行 frontend 定向测试、类型检查和 lint。
- 在国内站与国际站预览各完成一次桌面端视觉验收。

## 风险与控制

- 不同实例 Hermes 版本可能返回不同 Catalog：以前端严格解析与 LightVela 模板兜底控制。
- 官方 Prompt 或字段随 Hermes 升级变化：由实例运行时作为事实源，不在前端复制执行 Prompt。
- 模板数量增加造成浏览压力：用分类筛选和固定每页 6 张控制密度。
- 某些 Blueprint 依赖未安装 Skill：卡片展示依赖，保存前继续使用现有 Skill 可用性校验。
