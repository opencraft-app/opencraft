# Changelog 上线节点与 DeepSeek Harness Beta 标识设计

**Status:** 原有上线节点与 Beta 标识已推送；自动任务测试运行条目已实现并通过双站验证，等待提交授权

## 目标

在不调整现有配图和月份结构的前提下，让 Changelog 准确表达 DeepSeek Harness Beta、国内站公测与正式上线节点，并补充双站自动任务支持测试运行的用户可见能力。

## 已确认文案与展示

### 2026 年 8 月 · DeepSeek Harness

- 国内站标题：`LightVela 实验室新增 DeepSeek Harness`
- 国际站使用对应本地化标题。
- 标题右侧显示 `Beta` 胶囊标签。
- 保留现有描述和国内/国际配图，不新增或替换图片。

### 2026 年 8 月 · 自动任务测试运行

- 国内站和国际站同步显示，放在各自 8 月更新日志最后一条。
- 国内站标题：`自动任务支持测试运行`。
- 国内站描述：`创建或编辑自动任务时，可以先运行一次当前填写的内容，无需保存即可确认执行效果，再决定是否创建或更新任务。`
- 国际站英文标题：`Jobs Now Support Test Runs`。
- 国际站英文描述：`When creating or editing a job, you can run the current form once without saving it, review the result, and then decide whether to create or update the job.`
- 不配图，使用现有 `visual: "none"` 能力。

### 2026 年 7 月 · 国内站正式上线

- 仅国内站显示，放在 7 月更新日志最后一条。
- 标题：`LightVela 正式上线并启用付费服务`
- 描述严格使用：`LightVela 产品中国站正式上线，同步启用付费服务。你可以根据使用需求选择合适的订阅套餐。`
- 不配图，使用现有 `visual: "none"` 能力。
- 国际站不显示该条目。

### 2026 年 4 月 · 产品公测

- 国内站标题从 `LightVela 产品内测上线` 改为 `LightVela 产品公测上线`。
- 国际站继续显示 `LightVela Product Beta Launch`，不改变国际站既有产品阶段表述。
- 保留现有描述和配图。

## 实现设计

- 为 `ChangelogEntry` 增加可选 `badge?: string` 字段，由 DeepSeek Harness 条目设置为 `Beta`。
- 标题使用现有 `h2`，内部增加无交互的文本标签；标签使用 Tailwind 默认颜色、圆角胶囊和紧凑字号，不添加动画或图标。
- 4 月标题使用区域分支，国内站读取新公测文案，国际站继续读取原有翻译键。
- 7 月正式上线条目只追加到 `!isGlobal` 分支末尾，确保顺序和区域边界由数据结构直接表达。
- 自动任务测试运行条目分别追加到国内站和国际站 8 月数组末尾，保持现有区域数组结构，不抽取新的共享层。

## 验证

- 国内站测试断言 DeepSeek 新标题与 Beta、4 月公测标题、7 月最后一条的精确文案和无图状态。
- 国际站测试断言 DeepSeek 本地化标题与 Beta、4 月英文标题保持不变，且不存在国内站 7 月付费服务条目。
- 国内站和国际站测试分别断言自动任务测试运行条目位于 8 月最后、文案准确且不渲染图片；国际站英文渲染使用已确认的 Title Case 标题和英文描述。
- 运行 Changelog 定向测试、i18n 提取/检查、TypeScript 检查、差异检查，并对国内/国际页面做浏览器 smoke。
